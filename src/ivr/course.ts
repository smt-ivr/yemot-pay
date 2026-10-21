import { normalizePhone } from "../lib/util";
import { d, goToFolder, idListMessage, priceParts, readTap, t, yemotResponse, type Part } from "../yemot/response";
import { EMPTY, V, exitFolder, failResponse, resolveCourse, restartResponse, type IvrContext } from "./common";

/**
 * שלוחת רכישת קורס.
 * פרמטרים מהשלוחה (api_add): key, course, pay, [price, name, source, exit, ok]
 *
 * 1. אם הוגדר ok: מי שיש לו גישה עובר לתוכן (ok). בלי ok אין בדיקה כאן -
 *    הבדיקה נעשית בשלוחת התוכן עם check_api (ראו check.ts), ומשם מי שאין לו גישה מגיע לכאן.
 * 2. הצעה לרכוש (1) או לצאת (2).
 * 3. רכישה: טלפון ראשון, טלפון שני (אפשר לדלג), אישור.
 * 4. נוצר מנוי pending עם הטלפונים, והשיחה עוברת לשלוחת התשלום של נדרים פלוס (pay).
 *    תשלום מוצלח -> המנוי פעיל (לצמיתות, או לפי access_days של הקורס).
 *    תשלום שנכשל -> אין גישה, והמתקשר יכול להיכנס לשלוחה שוב ולנסות מחדש.
 */
export async function handleCourse({ db, req }: IvrContext): Promise<Response> {
  const okFolder = req.get("mode") === "buy" ? null : req.get("ok");
  const payFolder = req.get("pay");
  if (!payFolder) {
    await db.log(req.phone, req.callId, "config_error", { endpoint: "course", missing: "pay" });
    return failResponse(req, "השלוחה לא הוגדרה כראוי");
  }

  const resolved = await resolveCourse(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { course: req.get("course") });
    return failResponse(req, resolved.message);
  }
  const { item: course, price } = resolved;
  const caller = normalizePhone(req.phone);

  // שלב 1: בדיקת גישה + תפריט
  const menu = req.get(V.menu);
  if (menu === null) {
    const hasAccess = caller !== null && (await db.hasCourseAccess(caller, course.id));
    if (hasAccess) {
      await db.log(req.phone, req.callId, "access_granted", { course_id: course.id });
      if (okFolder) return yemotResponse(goToFolder(okFolder));
      return yemotResponse(idListMessage([t("כבר יש לך גישה לקורס הזה")]), goToFolder(exitFolder(req)));
    }
    await db.log(req.phone, req.callId, "purchase_offer", { course_id: course.id });
    return yemotResponse(
      readTap([t(`לרכישת הקורס ${course.name}`), t("במחיר"), ...priceParts(price), t("הקישו 1, ליציאה הקישו 2")], {
        name: V.menu,
        max: 1,
        min: 1,
        digitsAllowed: ["1", "2"],
      }),
    );
  }
  if (menu !== "1") {
    await db.log(req.phone, req.callId, "purchase_declined", { course_id: course.id });
    return yemotResponse(goToFolder(exitFolder(req)));
  }

  // שלב 2: טלפון ראשון
  const phone1Raw = req.get(V.phone1);
  if (phone1Raw === null) {
    return yemotResponse(
      readTap([t("הקישו את מספר הטלפון הראשון שיקבל גישה לקורס")], { name: V.phone1, playback: "Phone", min: 9, max: 10 }),
    );
  }
  const phone1 = normalizePhone(phone1Raw);
  if (!phone1) return restartResponse(req, "מספר הטלפון שהוקש אינו תקין");

  // שלב 3: טלפון שני (אופציונלי)
  const allowSecond = Math.min(course.max_phones, 2) >= 2;
  const phone2Raw = allowSecond ? req.get(V.phone2) : EMPTY;
  if (phone2Raw === null) {
    return yemotResponse(
      readTap([t("הקישו מספר טלפון שני שיקבל גישה לקורס, או סולמית לדילוג")], {
        name: V.phone2,
        playback: "Phone",
        min: 9,
        max: 10,
        allowEmpty: true,
        emptyValue: EMPTY,
      }),
    );
  }
  const phone2 = phone2Raw === EMPTY ? null : normalizePhone(phone2Raw);
  if (phone2Raw !== EMPTY && !phone2) return restartResponse(req, "מספר הטלפון שהוקש אינו תקין");
  const phones = phone2 && phone2 !== phone1 ? [phone1, phone2] : [phone1];

  // שלב 4: אישור
  const confirm = req.get(V.confirm);
  if (confirm === null) {
    const phoneParts: Part[] = phones.flatMap((p, i) => (i === 0 ? [d(p)] : [t("ו"), d(p)]));
    return yemotResponse(
      readTap(
        [
          t(`לאישור רכישת הקורס ${course.name}`),
          t("במחיר"),
          ...priceParts(price),
          t(phones.length > 1 ? "עבור הטלפונים" : "עבור הטלפון"),
          ...phoneParts,
          t("הקישו 1, לביטול הקישו 2"),
        ],
        { name: V.confirm, max: 1, min: 1, digitsAllowed: ["1", "2"] },
      ),
    );
  }
  if (confirm !== "1") {
    await db.log(req.phone, req.callId, "purchase_cancelled", { course_id: course.id });
    return yemotResponse(idListMessage([t("הרכישה בוטלה")]), goToFolder(exitFolder(req)));
  }

  // שלב 5: יצירת מנוי ממתין ומעבר לתשלום
  const customer = await db.ensureCustomer(caller ?? phone1);
  const subscriptionId = await db.createPendingSubscription(customer.id, course.id, price, phones);
  await db.log(req.phone, req.callId, "purchase_pending", { subscription_id: subscriptionId, course_id: course.id, price, phones });
  return yemotResponse(idListMessage([t("מעבירים אותך לתשלום")]), goToFolder(payFolder));
}
