import type { TenantDb } from "../db/repo";
import type { Course, Product, ProductType } from "../db/types";
import { parsePrice } from "../lib/util";
import type { YemotRequest } from "../yemot/request";
import { goToFolder, idListMessage, t, yemotResponse } from "../yemot/response";

/** שמות הערכים שנאספים בשיחה. קידומת yp_ כדי לא להתנגש בערכים אחרים בשלוחה. */
export const V = {
  menu: "yp_menu",
  phone1: "yp_phone1",
  phone2: "yp_phone2",
  contact: "yp_contact",
  confirm: "yp_confirm",
} as const;

/** ערך שנשלח כשהמחייג דילג על הקשה */
export const EMPTY = "none";

export interface IvrContext {
  db: TenantDb;
  req: YemotRequest;
}

export function exitFolder(req: YemotRequest): string {
  return req.get("exit") ?? "hangup";
}

export function failResponse(req: YemotRequest, message = "אירעה תקלה, נסו שוב מאוחר יותר"): Response {
  return yemotResponse(idListMessage([t(message)]), goToFolder(exitFolder(req)));
}

/** הפעלה מחדש של השלוחה (מנקה את הערכים שנאספו). */
export function restartResponse(req: YemotRequest, message: string): Response {
  const target = req.extension ? `/${req.extension}` : exitFolder(req);
  return yemotResponse(idListMessage([t(message)]), goToFolder(target));
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

export type Resolved<T> = { item: T; price: number } | { error: string; message: string };

export async function resolveCourse(db: TenantDb, req: YemotRequest): Promise<Resolved<Course>> {
  const ref = req.get("course");
  if (!ref) return { error: "missing_course_param", message: "השלוחה לא הוגדרה כראוי" };

  const source = priceSource(req);
  const paramPrice = parsePrice(req.get("price"));
  if (source === "params" && paramPrice === null) return { error: "invalid_price_param", message: "השלוחה לא הוגדרה כראוי" };

  let course = await db.findCourse(ref);
  if (!course && source === "params") {
    course = await db.createCourse({ name: req.get("name") ?? ref, ivrCode: ref, price: paramPrice! });
  }
  if (!course) return { error: "course_not_found", message: "הקורס לא נמצא" };
  if (!course.is_active) return { error: "course_inactive", message: "הקורס אינו זמין כרגע" };

  return { item: course, price: source === "params" ? paramPrice! : course.price };
}

const PRODUCT_TYPES: ProductType[] = ["product", "meeting", "phone_meeting"];

export async function resolveProduct(db: TenantDb, req: YemotRequest): Promise<Resolved<Product>> {
  const ref = req.get("product");
  if (!ref) return { error: "missing_product_param", message: "השלוחה לא הוגדרה כראוי" };

  const source = priceSource(req);
  const paramPrice = parsePrice(req.get("price"));
  if (source === "params" && paramPrice === null) return { error: "invalid_price_param", message: "השלוחה לא הוגדרה כראוי" };

  let product = await db.findProduct(ref);
  if (!product && source === "params") {
    const typeParam = req.get("type") as ProductType | null;
    const type = typeParam && PRODUCT_TYPES.includes(typeParam) ? typeParam : "product";
    product = await db.createProduct({ name: req.get("name") ?? ref, ivrCode: ref, type, price: paramPrice! });
  }
  if (!product) return { error: "product_not_found", message: "המוצר לא נמצא" };
  if (!product.is_active) return { error: "product_inactive", message: "המוצר אינו זמין כרגע" };

  return { item: product, price: source === "params" ? paramPrice! : product.price };
}
