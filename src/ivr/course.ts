import { normalizePhone } from "../lib/util";
import { d, goToFolder, idListMessage, n, priceParts, readTap, t, yemotResponse, type Part } from "../yemot/response";
import { V, afterPurchaseFolder, exitFolder, failResponse, resolveCourse, type IvrContext } from "./common";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";

/**
 * שלוחת רכישת קורס (type=api) - תת-שלוחה של שלוחת הקורס, שאליה check_api מעביר מי שאין לו גישה.
 * פרמטרים מהשלוחה (api_add): key, course, [ok, exit, price, name, source]
 *
 * 1. "אין לך מנוי" / "תוקף המנוי הסתיים" + "לרכישת גישה לקורס [למשך N ימים] במחיר X" - 1, ליציאה 2.
 * 2. טלפונים: הראשון - 1 למספר המתקשר או הקשת מספר; ואז "להוספת מספר נוסף 1, להמשך 2",
 *    עד מספר הטלפונים שהוגדר בקורס. מספר שכבר יש לו מנוי לקורס - מתבקש מספר אחר.
 * 3. סליקה בנדרים פלוס דרך ימות (credit_card). ימות חוזרת עם CreditCard_CODE ועם כל הערכים שנאספו:
 *    OK -> רק עכשיו נוצרים הרוכש, המנוי והתשלום. "רכשת בהצלחה" ומעבר לקורס.
 *    אחר -> לא נוצר כלום. יציאה.
 */
export async function handleCourse({ db, req }: IvrContext): Promise<Response> {
  const resolved = await resolveCourse(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { course: req.get("course") });
    return failResponse(req, resolved.message);
  }
  const { item: course, price } = resolved;
  const caller = normalizePhone(req.phone);
  const maxPhones = Math.max(1, course.max_phones || 1);

  // 1. פתיחה + תפריט
  const menu = req.get(V.menu);
  if (menu === null) {
    const status = caller ? await db.courseAccessStatus(caller, course.id) : "none";
    if (status === "active") {
      await db.log(req.phone, req.callId, "access_granted", { course_id: course.id });
      return yemotResponse(goToFolder(afterPurchaseFolder(req)));
    }
    await db.log(req.phone, req.callId, "purchase_offer", { course_id: course.id, status });
    const intro = status === "expired" ? `תוקף המנוי שלך לקורס ${course.name} הסתיים` : `אין לך מנוי לקורס ${course.name}`;
    const duration: Part[] = course.access_days ? [t("למשך"), n(course.access_days), t("ימים")] : [];
    return yemotResponse(
      readTap([t(intro), t("לרכישת גישה לקורס"), ...duration, t("במחיר"), ...priceParts(price), t("הקישו 1, ליציאה הקישו 2")], {
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

  // 2. טלפונים
  const phones: string[] = [];
  for (let i = 1; i <= maxPhones; i++) {
    const name = `${V.phone}${i}`;
    const prompt: Part[] =
      i > 1
        ? [t("הקישו את המספר הנוסף וסולמית")]
        : caller
          ? [t("לשימוש במספר שממנו התקשרתם הקישו 1, למספר אחר הקישו את המספר וסולמית")]
          : [t("הקישו מספר טלפון וסולמית")];
    const ask = (problem: Part[] = []) =>
      yemotResponse(readTap([...problem, ...prompt], { name, reEnter: true, min: i === 1 && caller ? 1 : 9, max: 10 }));

    const raw = req.get(name);
    if (raw === null) return ask();
    const phone = i === 1 && raw === "1" && caller ? caller : normalizePhone(raw);
    if (!phone) return ask([t("המספר שהוקש שגוי")]);
    if (phones.includes(phone)) return ask([t("המספר הזה כבר הוקש")]);
    if (await db.hasCourseAccess(phone, course.id)) return ask([t("למספר"), d(phone), t("כבר יש מנוי לקורס")]);
    phones.push(phone);

    if (i === maxPhones) break;
    const moreName = `${V.more}${i}`;
    const more = req.get(moreName);
    if (more === null) {
      return yemotResponse(
        readTap([t("להוספת מספר נוסף הקישו 1, להמשך הקישו 2")], { name: moreName, max: 1, min: 1, digitsAllowed: ["1", "2"] }),
      );
    }
    if (more !== "1") break;
  }

  // 3. סליקה - עדיין לא נשמר כלום
  const code = paymentCode(req);
  if (code === null) {
    await db.log(req.phone, req.callId, "payment_started", { course_id: course.id, price, phones });
    return startPayment(db, req, price);
  }

  // 4. חזרה מהסליקה
  if (code !== "OK") {
    await db.log(req.phone, req.callId, "payment_not_completed", { course_id: course.id, code });
    return paymentNotCompleted(req);
  }

  const tx = transactionId(req);
  if (!(await db.paymentExists(PROVIDER, tx))) {
    const customer = await db.ensureCustomer(caller ?? phones[0]!);
    const subscriptionId = await db.createPaidSubscription({
      customerId: customer.id,
      courseId: course.id,
      price,
      phones,
      accessDays: course.access_days,
      payment: { provider: PROVIDER, transactionId: tx },
    });
    await db.log(req.phone, req.callId, "payment_success", { subscription_id: subscriptionId, course_id: course.id, price, phones });
  }
  const validity: Part[] = course.access_days ? [t("המנוי בתוקף ל"), n(course.access_days), t("ימים")] : [];
  return yemotResponse(idListMessage([t(`רכשת בהצלחה את הקורס ${course.name}`), ...validity]), goToFolder(afterPurchaseFolder(req)));
}
