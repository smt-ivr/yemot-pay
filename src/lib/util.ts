/** מנרמל טלפון ישראלי לפורמט 0XXXXXXXXX. מחזיר null אם המספר לא תקין. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  return /^0\d{8,9}$/.test(digits) ? digits : null;
}

/** מחיר חיובי עם עד 2 ספרות אחרי הנקודה. */
export function parsePrice(raw: string | null | undefined): number | null {
  if (!raw || !/^\d+(\.\d{1,2})?$/.test(raw)) return null;
  const n = Number(raw);
  return n > 0 ? n : null;
}

export function sameAmount(a: number, b: number): boolean {
  return Math.abs(a - b) < 0.005;
}

export function todayIso(now = new Date()): string {
  return now.toISOString().slice(0, 10);
}

/** מוסיף חודשים לתאריך YYYY-MM-DD, עם הצמדה לסוף החודש (31/01 -> 28/02). */
export function addMonths(isoDate: string, months: number): string {
  const [y, m, d] = isoDate.split("-").map(Number) as [number, number, number];
  const target = new Date(Date.UTC(y, m - 1 + months, 1));
  const lastDay = new Date(Date.UTC(target.getUTCFullYear(), target.getUTCMonth() + 1, 0)).getUTCDate();
  target.setUTCDate(Math.min(d, lastDay));
  return target.toISOString().slice(0, 10);
}

/** מסתיר רצפי ספרות ארוכים (מספרי כרטיס) ומשאיר 4 אחרונות. */
export function maskSensitive(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\d{12,19}/g, (m) => "*".repeat(m.length - 4) + m.slice(-4));
}
