import { normalizePhone } from "../lib/util";
import { resolveCourse, type IvrContext } from "./common";

const text = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });

/**
 * בדיקת הרשאת כניסה (check_api=yes) בשלוחת תוכן הקורס.
 * ימות שולחת את כל ערכי השלוחה ומצפה לתשובה:
 *   OK  - ממשיך לשלוחה
 *   NO  - יוצא עם הודעת "אין לכם הרשאת גישה" ועובר ל-api_goto
 *   Out - יוצא בלי הודעה ועובר ל-api_goto (למשל לשלוחת הרכישה)
 * כל תשובה אחרת (שגיאה) -> api_error_goto.
 * פרמטרים: key, course, [deny=no|out] (ברירת מחדל out)
 */
export async function handleCheck({ db, req }: IvrContext): Promise<Response> {
  const resolved = await resolveCourse(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { endpoint: "check", course: req.get("course") });
    return text("ERROR");
  }
  const course = resolved.item;
  const caller = normalizePhone(req.phone);

  if (caller && (await db.hasCourseAccess(caller, course.id))) {
    await db.log(req.phone, req.callId, "access_granted", { course_id: course.id });
    return text("OK");
  }
  await db.log(req.phone, req.callId, "access_denied", { course_id: course.id });
  return text(req.get("deny") === "no" ? "NO" : "Out");
}
