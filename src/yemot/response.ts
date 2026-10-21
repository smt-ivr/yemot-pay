/**
 * בניית תשובות למודול API של ימות המשיח.
 * כמה פעולות בתשובה אחת מחוברות ב-&, וחלקי הודעה מחוברים בנקודה.
 */

export type Part =
  | { kind: "t"; value: string } // טקסט להקראה (TTS)
  | { kind: "f"; value: string } // קובץ שמע בשלוחה
  | { kind: "n"; value: number } // מספר
  | { kind: "d"; value: string }; // ספרות

/** תווים ששוברים את התחביר של ימות. */
const FORBIDDEN = /[.\-"'&|=,]/g;

export function sanitizeText(text: string): string {
  return text.replace(FORBIDDEN, " ").replace(/\s+/g, " ").trim();
}

export const t = (value: string): Part => ({ kind: "t", value: sanitizeText(value) });
export const f = (value: string): Part => ({ kind: "f", value: value.replace(/[^\w/]/g, "") });
export const n = (value: number): Part => ({ kind: "n", value: Math.trunc(value) });
export const d = (value: string): Part => ({ kind: "d", value: value.replace(/\D/g, "") });

function joinParts(parts: Part[]): string {
  return parts.map((p) => `${p.kind}-${p.value}`).join(".");
}

export function idListMessage(parts: Part[]): string {
  return `id_list_message=${joinParts(parts)}`;
}

export function goToFolder(target: string): string {
  return `go_to_folder=${target}`;
}

export type PlaybackMode = "No" | "Number" | "Digits" | "Phone" | "Price" | "TeudatZehut";

export interface TapOptions {
  /** שם הערך שיחזור בבקשה הבאה */
  name: string;
  /** לבקש שוב גם אם כבר יש ערך בשם הזה (לבקשה חוזרת אחרי הקשה שגויה) */
  reEnter?: boolean;
  max?: number;
  min?: number;
  secWait?: number;
  playback?: PlaybackMode;
  blockAsterisk?: boolean;
  blockZero?: boolean;
  digitsAllowed?: string[];
  attempts?: number;
  allowEmpty?: boolean;
  emptyValue?: string;
}

/** בקשת הקשה: read=הודעה=name,re_enter,max,min,sec,playback,block*,block0,replace,allowed,attempts,allow_empty,empty_val,keyboard */
export function readTap(parts: Part[], o: TapOptions): string {
  const ops = [
    o.name,
    o.reEnter ? "yes" : "no",
    o.max ?? "",
    o.min ?? 1,
    o.secWait ?? 7,
    o.playback ?? "No",
    o.blockAsterisk ? "yes" : "no",
    o.blockZero ? "yes" : "no",
    "",
    (o.digitsAllowed ?? []).join("."),
    o.attempts ?? "",
    o.allowEmpty ? "Ok" : "",
    o.emptyValue ?? "",
    "",
  ];
  return `read=${joinParts(parts)}=${ops.join(",")}`;
}

export function yemotResponse(...actions: string[]): Response {
  return new Response(actions.join("&"), {
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

/** מקריא מחיר בלי נקודה עשרונית (נקודה אסורה בטקסט). */
export function priceParts(price: number): Part[] {
  if (price <= 0) return [t("ללא תשלום")];
  const shekels = Math.floor(price);
  const agorot = Math.round((price - shekels) * 100);
  const parts: Part[] = [n(shekels), t("שקלים")];
  if (agorot > 0) parts.push(t("ו"), n(agorot), t("אגורות"));
  return parts;
}

/**
 * מעבר לסליקת אשראי מתוך מודול API (ערכים לפי הסדר בתיעוד של ימות):
 * סוג, סכום, מס' חנות, תשלומים, מטבע, סוג פלאקארד, משתמש, מספר טרמינל (בנדרים פלוס: מספר המוסד),
 * סיסמה, all, טלפון, שם, ללא אישור, טוקן, GoBack.
 * אחרי סליקה מוצלחת ימות קוראת שוב לאותה כתובת עם כל הערכים + CreditCard_CODE=OK.
 * GoBack: הקשה על כוכבית בסליקה מחזירה אלינו עם CreditCard_CODE=GoBack (במקום לולאה).
 */
export function creditCard(o: { type: "nedarim_plus"; sum: number; terminal: string; tashloumim?: number }): string {
  const sum = String(Math.round(o.sum * 100) / 100);
  const terminal = o.terminal.replace(/\D/g, "");
  return `credit_card=${[o.type, sum, "", o.tashloumim ?? 1, 1, "", "", terminal, "", "", "", "", "", "", "GoBack"].join(",")}`;
}
