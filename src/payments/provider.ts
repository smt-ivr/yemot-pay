/**
 * החיוב עצמו לא מתבצע אצלנו - הוא מתבצע אצל ספק הסליקה (כרגע נדרים פלוס דרך ימות המשיח).
 * אצלנו רק מקבלים עדכון (callback) על תוצאת החיוב ומעדכנים מנויים / הזמנות / payments.
 * כל ספק מממש מתאם שמתרגם את העדכון שלו לאירוע אחיד.
 */
export interface PaymentEvent {
  status: "success" | "failed";
  amount: number;
  transactionId: string | null;
  /** טלפון המשלם כפי שדווח ע"י הספק */
  phone: string | null;
  cardLast4: string | null;
  installments: number;
  /** הפניה מפורשת לרכישה אצלנו, אם הועברה לספק: "s123" למנוי או "o45" להזמנה */
  reference: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  /** הנתונים המקוריים, לרישום ביומן (אחרי מיסוך) */
  raw: Record<string, string>;
}

export interface PaymentAdapter {
  readonly name: string;
  parse(request: Request): Promise<PaymentEvent | null>;
}

/** קורא את גוף הבקשה (JSON / טופס) ואת פרמטרי ה-URL לאובייקט שטוח של מחרוזות. */
export async function readFlatPayload(request: Request): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  new URL(request.url).searchParams.forEach((v, k) => {
    if (k !== "key") out[k] = v;
  });
  if (request.method !== "POST") return out;

  const type = request.headers.get("content-type") ?? "";
  if (type.includes("application/json")) {
    const body = (await request.json().catch(() => null)) as Record<string, unknown> | null;
    if (body && typeof body === "object") {
      for (const [k, v] of Object.entries(body)) {
        if (v !== null && v !== undefined && typeof v !== "object") out[k] = String(v);
      }
    }
  } else if (type.includes("form")) {
    const form = await request.formData();
    form.forEach((v, k) => {
      if (typeof v === "string") out[k] = v;
    });
  }
  return out;
}
