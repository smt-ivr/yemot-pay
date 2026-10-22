import type { TenantDb } from "../db/repo";
import type { YemotRequest } from "../yemot/request";
import { creditCard, goToFolder, idListMessage, yemotResponse } from "../yemot/response";
import { exitFolder, failResponse } from "./common";
import { sayText } from "./texts";

export const PROVIDER = "nedarim_plus";

/** התשובה שימות מוסיפה אחרי הסליקה: OK בהצלחה, GoBack אם המתקשר יצא בכוכבית. null = עדיין לא נסלק. */
export function paymentCode(req: YemotRequest): string | null {
  return req.get("CreditCard_CODE");
}

/** מזהה עסקה לכל שיחה, כדי שאישור כפול מימות לא ייספר פעמיים. */
export function transactionId(req: YemotRequest): string {
  return `yemot-${req.callId || "unknown"}`;
}

/** מעבר לסליקה בנדרים פלוס. בלי מספר מוסד מוגדר ללקוח - הודעת תקלה. */
export async function startPayment(db: TenantDb, req: YemotRequest, amount: number): Promise<Response> {
  const mosad = db.tenant.nedarim_mosad_id?.replace(/\D/g, "");
  if (!mosad) {
    await db.log(req.phone, req.callId, "config_error", { missing: "nedarim_mosad_id" });
    return failResponse(req, sayText(db.tenant, "payment_not_configured"));
  }
  return yemotResponse(creditCard({ type: "nedarim_plus", sum: amount, terminal: mosad }));
}

export function paymentNotCompleted(db: TenantDb, req: YemotRequest): Response {
  return yemotResponse(idListMessage(sayText(db.tenant, "payment_not_completed")), goToFolder(exitFolder(req)));
}
