import { normalizePhone } from "../lib/util";
import { d, goToFolder, idListMessage, n, priceParts, readTap, t, yemotResponse, type Part } from "../yemot/response";
import { notify } from "../email";
import { V, afterPurchaseFolder, askPhone, exitFolder, failResponse, resolveCourse, type IvrContext } from "./common";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";
import { sayText, type TextKey } from "./texts";

/** "במחיר 100 שקלים", או "ללא תשלום" */
export function pricePhrase(price: number): Part[] {
  return price > 0 ? [t("במחיר"), ...priceParts(price)] : priceParts(price);
}

/**
 * שלוחת רכישת קורס (type=api) - תת-שלוחה של שלוחת הקורס, שאליה check_api מעביר מי שאין לו גישה.
 * פרמטרים מהשלוחה (api_add): client, key, course, [ok, exit, price, name, source]
 * כל הטקסטים ניתנים לשינוי (הגדרות ← טקסטים בשיחה), וטקסט ההצעה וההצלחה גם בקורס עצמו.
 *
 * 1. "אין לך מנוי" / "תוקף המנוי הסתיים" + "לרכישת גישה לקורס [למשך N ימים] במחיר X" - 1, ליציאה 2.
 * 2. טלפונים: הראשון - המספר שממנו התקשרו. אם בקורס מותר לבחור טלפון אחר: 1 וסולמית למספר המתקשר
 *    (בלי אישור), או הקשת מספר (עם אישור). ואז "להוספת מספר נוסף 1, להמשך 2", עד מספר הטלפונים שבקורס.
 *    מספר לא תקין, כפול, או שכבר יש לו מנוי לקורס - מתבקש מספר אחר.
 * 3. סליקה בנדרים פלוס דרך ימות (credit_card). ימות חוזרת עם CreditCard_CODE ועם כל הערכים שנאספו:
 *    OK -> רק עכשיו נוצרים הרוכש, המנוי והתשלום. "רכשת בהצלחה" ומעבר לקורס.
 *    אחר -> לא נוצר כלום. יציאה.
 */
export async function handleCourse({ db, req, waitUntil }: IvrContext): Promise<Response> {
  const resolved = await resolveCourse(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { course: req.get("course") });
    return failResponse(req, resolved.message);
  }
  const { item: course, price } = resolved;
  const caller = normalizePhone(req.phone);
  const maxPhones = Math.max(1, course.max_phones || 1);
  const say = (key: TextKey, vars?: Record<string, string | Part[]>, override?: string | null) => sayText(db.tenant, key, { name: course.name, ...vars }, override);

  // 1. פתיחה + תפריט
  const menu = req.get(V.menu);
  if (menu === null) {
    const status = caller ? await db.courseAccessStatus(caller, course.id) : "none";
    if (status === "active") {
      await db.log(req.phone, req.callId, "access_granted", { course_id: course.id });
      return yemotResponse(goToFolder(afterPurchaseFolder(req)));
    }
    await db.log(req.phone, req.callId, "purchase_offer", { course_id: course.id, status });
    const duration: Part[] = course.access_days ? [t("למשך"), n(course.access_days), t("ימים")] : [];
    return yemotResponse(
      readTap([...say(status === "expired" ? "course_expired" : "course_no_sub"), ...say("course_offer", { duration, price: pricePhrase(price) }, course.offer_text)], {
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

  // 2. טלפונים - כל מספר נבדק (תקין, לא כפול, בלי מנוי קיים) ומספר שהוקש ידנית מאושר.
  //    כשאסור לבחור טלפון אחר, הטלפון הראשון הוא המספר שממנו התקשרו (אם הוא לא חסוי).
  const phones: string[] = [];
  const askFirst = course.ask_phone !== 0 || !caller;
  for (let i = 1; i <= maxPhones; i++) {
    if (i === 1 && !askFirst) {
      phones.push(caller!);
    } else {
      const asked = await askPhone(db, req, {
        base: `${V.phone}${i}`,
        callerPhone: i === 1 ? caller : null,
        prompt: i > 1 ? say("course_next_phone") : caller ? say("course_first_phone") : say("phone_hidden"),
        check: async (phone) => {
          if (phones.includes(phone)) return say("phone_repeated");
          if (await db.hasCourseAccess(phone, course.id)) return say("course_phone_has_sub", { phone: [d(phone)] });
          return null;
        },
      });
      if ("response" in asked) return asked.response;
      phones.push(asked.phone);
    }

    if (i === maxPhones) break;
    const moreName = `${V.more}${i}`;
    const more = req.get(moreName);
    if (more === null) {
      return yemotResponse(
        readTap(say("course_add_more"), { name: moreName, max: 1, min: 1, digitsAllowed: ["1", "2"] }),
      );
    }
    if (more !== "1") break;
  }

  // 3. סליקה - עדיין לא נשמר כלום. קורס במחיר 0 (לבדיקות) לא עובר לסליקה ונרכש מיד.
  const free = price <= 0;
  const code = free ? "OK" : paymentCode(req);
  if (code === null) {
    await db.log(req.phone, req.callId, "payment_started", { course_id: course.id, price, phones });
    return startPayment(db, req, price);
  }

  // 4. חזרה מהסליקה
  if (code !== "OK") {
    await db.log(req.phone, req.callId, "payment_not_completed", { course_id: course.id, code });
    return paymentNotCompleted(db, req);
  }

  const tx = transactionId(req);
  if (!(await db.paymentExists(free ? "free" : PROVIDER, tx))) {
    const customer = await db.ensureCustomer(caller ?? phones[0]!);
    const subscriptionId = await db.createPaidSubscription({
      customerId: customer.id,
      courseId: course.id,
      price,
      phones,
      accessDays: course.access_days,
      payment: { provider: free ? "free" : PROVIDER, transactionId: tx },
    });
    await db.log(req.phone, req.callId, "payment_success", { subscription_id: subscriptionId, course_id: course.id, price, phones });
    waitUntil(
      notify(
        db,
        course,
        {
          kind: "course",
          item: course.name,
          price: price > 0 ? `${price} ₪` : "ללא תשלום",
          phones: phones.join(", "),
          buyer_phone: caller ?? "חסוי",
          validity: course.access_days ? `${course.access_days} ימים` : "לצמיתות",
          reference: String(subscriptionId),
        },
        { idempotencyKey: `${db.tenant.slug}-sub-${subscriptionId}` },
      ),
    );
  }
  const validity = course.access_days ? say("course_validity", { days: [n(course.access_days)] }) : [];
  return yemotResponse(idListMessage([...say("course_success", {}, course.success_text), ...validity]), goToFolder(afterPurchaseFolder(req)));
}
