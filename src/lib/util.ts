/** מנרמל טלפון ישראלי (972 -> 0) ובודק שהוא מספר אמיתי. מחזיר null אם המספר לא תקין. */
export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("972")) digits = "0" + digits.slice(3);
  // נייד 05X ו-07X (10 ספרות), קווי 02/03/04/08/09 (9 ספרות)
  return /^(?:05\d{8}|07[2-9]\d{7}|0[23489][2-9]\d{6})$/.test(digits) ? digits : null;
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

/** מוסיף ימים לתאריך YYYY-MM-DD. */
export function addDays(isoDate: string, days: number): string {
  const date = new Date(`${isoDate}T00:00:00Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

/** מסתיר רצפי ספרות ארוכים (מספרי כרטיס) ומשאיר 4 אחרונות. */
export function maskSensitive(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value);
  return text.replace(/\d{12,19}/g, (m) => "*".repeat(m.length - 4) + m.slice(-4));
}
