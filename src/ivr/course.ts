import { normalizePhone } from "../lib/util";
import { d, goToFolder, idListMessage, priceParts, readTap, t, yemotResponse, type Part } from "../yemot/response";
import { EMPTY, V, exitFolder, failResponse, resolveCourse, restartResponse, type IvrContext } from "./common";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";

/**
 * שלוחת רכישת קורס (type=api).
 * פרמטרים מהשלוחה (api_add): key, course, [ok, exit, price, name, source]
 *
 * 1. מי שכבר יש לו גישה: עובר לתוכן (ok), או שומע הודעה ויוצא.
 * 2. הצעה לרכוש (1) או לצאת (2).
 * 3. טלפון ראשון, טלפון שני (אפשר לדלג), אישור.
 * 4. נוצר מנוי pending, והשרת עונה credit_card=nedarim_plus,... - ימות מבצעת את הסליקה.
 * 5. ימות קוראת שוב עם CreditCard_CODE:
 *    OK -> המנוי פעיל (לצמיתות, או לפי access_days של הקורס) ומעבר לתוכן (ok).
 *    אחר (GoBack) -> אין גישה, אפשר להיכנס שוב.
 */
export async function handleCourse({ db, req }: IvrContext): Promise<Response> {
  const okFolder = req.get("ok");

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
    if (caller && (await db.hasCourseAccess(caller, course.id))) {
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

  const customer = await db.ensureCustomer(caller ?? phone1);
  const code = paymentCode(req);

  // שלב 5: מנוי ממתין ומעבר לסליקה
  if (code === null) {
    const subscriptionId = await db.createPendingSubscription(customer.id, course.id, price, phones);
    await db.log(req.phone, req.callId, "purchase_pending", { subscription_id: subscriptionId, course_id: course.id, price, phones });
    return startPayment(db, req, price);
  }

  // שלב 6: חזרה מהסליקה
  const tx = transactionId(req);
  const done = () =>
    yemotResponse(idListMessage([t("התשלום התקבל בהצלחה, יש לך גישה לקורס")]), goToFolder(okFolder ?? exitFolder(req)));
  if (code === "OK" && (await db.paymentExists(PROVIDER, tx))) return done();

  const pending = (await db.findPendingSubscriptions(customer.id)).find((s) => s.course_id === course.id);
  if (!pending) {
    await db.log(req.phone, req.callId, "payment_without_pending", { code, course_id: course.id });
    return failResponse(req, code === "OK" ? "התשלום התקבל, אך אירעה תקלה ברישום. אנא פנו למשרד" : undefined);
  }

  if (code === "OK") {
    await db.db.batch([
      db.insertPayment({ customerId: customer.id, subscriptionId: pending.id, amount: pending.price, status: "success", provider: PROVIDER, transactionId: tx }),
      db.activateSubscription(pending.id, course.access_days),
    ]);
    await db.log(req.phone, req.callId, "payment_success", { subscription_id: pending.id, amount: pending.price });
    return done();
  }

  await db.db.batch([
    db.insertPayment({ customerId: customer.id, subscriptionId: pending.id, amount: pending.price, status: "failed", provider: PROVIDER, transactionId: tx, errorCode: code }),
    db.markSubscriptionFailed(pending.id),
  ]);
  await db.log(req.phone, req.callId, "payment_not_completed", { subscription_id: pending.id, code });
  return paymentNotCompleted(req);
}
