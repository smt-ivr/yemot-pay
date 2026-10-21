import { readFlatPayload, type PaymentAdapter, type PaymentEvent } from "./provider";

/**
 * ⚠️ לא מאומת: שמות השדות כאן לא נבדקו מול התיעוד הרשמי של נדרים פלוס או מול עדכון אמיתי.
 * לפני עלייה לאוויר צריך להשוות לעדכון אמיתי (הוא נרשם ב-ivr_log בפעולות payment_*, בשדה raw),
 * ולתקן רק את המיפוי הזה. כל שאר הקוד לא תלוי בשמות השדות.
 * לכל שדה אפשר לרשום כמה שמות אפשריים - נלקח הראשון שקיים.
 */
export const NEDARIM_FIELDS = {
  status: ["Status", "Result"],
  amount: ["Amount", "Sum"],
  transactionId: ["TransactionId", "Confirmation"],
  phone: ["Phone", "ApiPhone"],
  cardLast4: ["LastNum", "Last4"],
  installments: ["Tashloumim", "Tashlumim"],
  reference: ["Param1", "Comments"],
  errorMessage: ["Message", "ErrorMessage"],
  errorCode: ["ErrorCode"],
} as const;

const SUCCESS_VALUES = new Set(["ok", "success", "approved", "true", "1"]);

function pick(raw: Record<string, string>, names: readonly string[]): string | null {
  for (const name of names) {
    const v = raw[name];
    if (v !== undefined && v !== "") return v;
  }
  return null;
}

export const nedarimAdapter: PaymentAdapter = {
  name: "nedarim_plus",

  async parse(request: Request): Promise<PaymentEvent | null> {
    const raw = await readFlatPayload(request);
    const amount = Number(pick(raw, NEDARIM_FIELDS.amount));
    if (!Number.isFinite(amount) || amount <= 0) return null;

    const statusRaw = (pick(raw, NEDARIM_FIELDS.status) ?? "").toLowerCase();
    const last4 = pick(raw, NEDARIM_FIELDS.cardLast4)?.replace(/\D/g, "").slice(-4) ?? null;
    const reference = pick(raw, NEDARIM_FIELDS.reference);

    return {
      status: SUCCESS_VALUES.has(statusRaw) ? "success" : "failed",
      amount,
      transactionId: pick(raw, NEDARIM_FIELDS.transactionId),
      phone: pick(raw, NEDARIM_FIELDS.phone),
      cardLast4: last4 || null,
      installments: Number(pick(raw, NEDARIM_FIELDS.installments)) || 1,
      reference: reference && /^[so]\d+$/i.test(reference.trim()) ? reference.trim().toLowerCase() : null,
      errorCode: pick(raw, NEDARIM_FIELDS.errorCode),
      errorMessage: pick(raw, NEDARIM_FIELDS.errorMessage),
      raw,
    };
  },
};
