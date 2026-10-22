import type { TenantDb } from "../db/repo";
import type { Course, Product } from "../db/types";
import { normalizePhone, parsePrice } from "../lib/util";
import type { YemotRequest } from "../yemot/request";
import { d, goToFolder, idListMessage, readTap, t, yemotResponse, type Part } from "../yemot/response";
import { sayText } from "./texts";

/** שמות הערכים שנאספים בשיחה. קידומת yp_ כדי לא להתנגש בערכים אחרים בשלוחה. */
export const V = {
  menu: "yp_menu",
  /** + מספר: yp_phone1, yp_phone2, ... */
  phone: "yp_phone",
  /** + מספר: yp_more1, ... - האם להוסיף טלפון נוסף */
  more: "yp_more",
  contact: "yp_contact",
  confirm: "yp_confirm",
} as const;

/** ערך שנשלח כשהמחייג דילג על הקשה */
export const EMPTY = "none";

export interface IvrContext {
  db: TenantDb;
  req: YemotRequest;
  /** משימות רקע אחרי התשובה לימות (למשל שליחת מייל), כדי שהשיחה לא תחכה */
  waitUntil: (promise: Promise<unknown>) => void;
}

const MAX_PHONE_ATTEMPTS = 4;

/**
 * שאלת מספר טלפון עם בדיקת תקינות ואישור.
 * כל ניסיון נשמר בשם משלו (base_1, base_2...) ואישורו ב-basec_1..., כך שימות שולחת את כל ההיסטוריה
 * ואפשר לדעת בכל בקשה איפה המתקשר עומד.
 * - callerPhone: הקשה על 1 = המספר שממנו התקשרו, בלי בקשת אישור.
 * - מספר שהוקש ידנית: "הקשתם ... לאישור 1, להקשה מחדש 2".
 * - check: בדיקה נוספת (כפילות, מנוי קיים) - מחזירה הודעה אם המספר לא מתאים.
 */
export async function askPhone(
  db: TenantDb,
  req: YemotRequest,
  o: { base: string; prompt: Part[]; callerPhone?: string | null; check?: (phone: string) => Promise<Part[] | null> },
): Promise<{ phone: string } | { response: Response }> {
  const say = (key: Parameters<typeof sayText>[1], vars?: Record<string, string | Part[]>) => sayText(db.tenant, key, vars);
  let problem: Part[] = [];
  for (let a = 1; a <= MAX_PHONE_ATTEMPTS; a++) {
    const name = `${o.base}_${a}`;
    const raw = req.get(name);
    if (raw === null) {
      return { response: yemotResponse(readTap([...problem, ...o.prompt], { name, min: o.callerPhone ? 1 : 9, max: 10 })) };
    }

    const shortcut = raw === "1" && !!o.callerPhone;
    const phone = shortcut ? o.callerPhone! : normalizePhone(raw);
    if (!phone) {
      problem = say("phone_invalid");
      continue;
    }
    const issue = o.check ? await o.check(phone) : null;
    if (issue) {
      problem = issue;
      continue;
    }
    if (!shortcut) {
      const confirmName = `${o.base}c_${a}`;
      const confirm = req.get(confirmName);
      if (confirm === null) {
        return {
          response: yemotResponse(
            readTap(say("phone_confirm", { phone: [d(phone)] }), { name: confirmName, max: 1, min: 1, digitsAllowed: ["1", "2"] }),
          ),
        };
      }
      if (confirm !== "1") {
        problem = [];
        continue;
      }
    }
    return { phone };
  }
  return { response: failResponse(req, say("phone_failed")) };
}

function extensionPath(req: YemotRequest): string[] {
  return req.extension.split("/").filter(Boolean);
}

/**
 * יציאה: exit מהשלוחה, ואם לא הוגדר - שתי רמות למעלה (שלוחת הרכישה היא תת-שלוחה של שלוחת הקורס,
 * ושלוחת הקורס תחזיר לכאן מי שאין לו גישה, לכן יוצאים אל מעליה).
 */
export function exitFolder(req: YemotRequest): string {
  const exit = req.get("exit");
  if (exit) return exit;
  const parts = extensionPath(req);
  return parts.length >= 2 ? `/${parts.slice(0, -2).join("/")}` : "hangup";
}

/** אחרי רכישה מוצלחת: ok מהשלוחה, ואם לא הוגדר - שלוחת הקורס (רמה אחת למעלה). */
export function afterPurchaseFolder(req: YemotRequest): string {
  const ok = req.get("ok");
  if (ok) return ok;
  const parts = extensionPath(req);
  return parts.length >= 1 ? `/${parts.slice(0, -1).join("/")}` : exitFolder(req);
}

export function failResponse(req: YemotRequest, message: string | Part[] = "אירעה תקלה, נסו שוב מאוחר יותר"): Response {
  return yemotResponse(idListMessage(typeof message === "string" ? [t(message)] : message), goToFolder(exitFolder(req)));
}


/**
 * מקור המחיר: "db" - לפי הגדרות הקורס/מוצר במסד, "params" - לפי price שנשלח מהשלוחה.
 * בלי source מפורש: אם נשלח price משתמשים בו, אחרת במסד.
 */
function priceSource(req: YemotRequest): "db" | "params" {
  const s = req.get("source");
  if (s === "db" || s === "params") return s;
  return req.get("price") ? "params" : "db";
}

export type Resolved<T> = { item: T; price: number } | { error: string; message: Part[] };

/** allowInactive: גם קורס לא פעיל (בבדיקת גישה - מי שכבר רכש ממשיך לקבל גישה). */
export async function resolveCourse(db: TenantDb, req: YemotRequest, opts: { allowInactive?: boolean } = {}): Promise<Resolved<Course>> {
  const say = (key: Parameters<typeof sayText>[1], vars?: Record<string, string>) => sayText(db.tenant, key, vars);
  const ref = req.get("course");
  if (!ref) return { error: "missing_course_param", message: say("bad_config") };

  const source = priceSource(req);
  const paramPrice = parsePrice(req.get("price"));
  if (source === "params" && paramPrice === null) return { error: "invalid_price_param", message: say("bad_config") };

  let course = await db.findCourse(ref);
  if (!course && source === "params") {
    course = await db.createCourse({ name: req.get("name") ?? ref, ivrCode: ref, price: paramPrice! });
  }
  if (!course) return { error: "course_not_found", message: say("course_not_found") };
  if (!course.is_active && !opts.allowInactive) return { error: "course_inactive", message: say("course_inactive", { name: course.name }) };

  return { item: course, price: source === "params" ? paramPrice! : course.price };
}

export async function resolveProduct(db: TenantDb, req: YemotRequest): Promise<Resolved<Product>> {
  const say = (key: Parameters<typeof sayText>[1], vars?: Record<string, string>) => sayText(db.tenant, key, vars);
  const ref = req.get("product");
  if (!ref) return { error: "missing_product_param", message: say("bad_config") };

  const source = priceSource(req);
  const paramPrice = parsePrice(req.get("price"));
  if (source === "params" && paramPrice === null) return { error: "invalid_price_param", message: say("bad_config") };

  let product = await db.findProduct(ref);
  if (!product && source === "params") {
    product = await db.createProduct({ name: req.get("name") ?? ref, ivrCode: ref, type: "product", price: paramPrice! });
  }
  if (!product) return { error: "product_not_found", message: say("product_not_found") };
  if (!product.is_active) return { error: "product_inactive", message: say("product_inactive", { name: product.name }) };

  return { item: product, price: source === "params" ? paramPrice! : product.price };
}
