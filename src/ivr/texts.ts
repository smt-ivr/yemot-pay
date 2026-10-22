import type { TenantConfig } from "../tenants";
import { t, type Part } from "../yemot/response";

/**
 * כל הטקסטים שהמתקשר שומע. לכל לקוח אפשר לשנות כל טקסט ממערכת הניהול (הגדרות ← טקסטים בשיחה),
 * ומה שלא שונה נשאר בברירת המחדל שכאן.
 * משתנים נכתבים בסוגריים מסולסלים: {name}. שם הוא טקסט, ומחיר / מספר / טלפון מוקראים כמספרים.
 */
export interface TextDef {
  group: string;
  label: string;
  default: string;
  /** המשתנים שאפשר לשים בטקסט הזה, עם הסבר */
  vars?: Record<string, string>;
}

const NAME = { name: "שם הקורס / המוצר" };
const PRICE = { price: 'המחיר ("במחיר 100 שקלים", או "ללא תשלום")' };

export const TEXTS = {
  course_no_sub: { group: "קורס", label: "פתיחה - אין מנוי", default: "אין לך מנוי לקורס {name}", vars: NAME },
  course_expired: { group: "קורס", label: "פתיחה - תוקף המנוי הסתיים", default: "תוקף המנוי שלך לקורס {name} הסתיים", vars: NAME },
  course_offer: {
    group: "קורס",
    label: "הצעת רכישה",
    default: "לרכישת גישה לקורס {duration} {price} הקישו 1, ליציאה הקישו 2",
    vars: { ...NAME, duration: 'התוקף ("למשך 30 ימים", או כלום אם הגישה לצמיתות)', ...PRICE },
  },
  course_first_phone: {
    group: "קורס",
    label: "טלפון ראשון",
    default: "לשימוש במספר שממנו התקשרתם הקישו 1 וסולמית, למספר אחר הקישו את המספר וסולמית",
  },
  course_next_phone: { group: "קורס", label: "טלפון נוסף", default: "הקישו את המספר הנוסף וסולמית" },
  course_add_more: { group: "קורס", label: "האם להוסיף טלפון", default: "להוספת מספר נוסף הקישו 1, להמשך הקישו 2" },
  course_phone_has_sub: { group: "קורס", label: "למספר כבר יש מנוי", default: "למספר {phone} כבר יש מנוי לקורס", vars: { phone: "הטלפון (מוקרא ספרה ספרה)" } },
  course_success: { group: "קורס", label: "רכישה הצליחה", default: "רכשת בהצלחה את הקורס {name}", vars: NAME },
  course_validity: { group: "קורס", label: "תוקף אחרי רכישה", default: "המנוי בתוקף ל {days} ימים", vars: { days: "מספר הימים" } },
  course_inactive: { group: "קורס", label: "הקורס לא פעיל", default: "הקורס {name} אינו פעיל כרגע", vars: NAME },
  course_not_found: { group: "קורס", label: "הקורס לא נמצא", default: "הקורס לא נמצא" },

  product_offer: { group: "מוצר", label: "הצעת רכישה", default: "לרכישת {name} {price} הקישו 1, ליציאה הקישו 2", vars: { ...NAME, ...PRICE } },
  product_phone: {
    group: "מוצר",
    label: "טלפון ליצירת קשר (כשמותר לבחור טלפון אחר)",
    default: "ליצירת קשר במספר שממנו התקשרתם הקישו 1 וסולמית, למספר אחר הקישו את המספר וסולמית",
  },
  product_success: { group: "מוצר", label: "רכישה הצליחה", default: "רכשת בהצלחה את {name}", vars: NAME },
  product_inactive: { group: "מוצר", label: "המוצר לא פעיל", default: "{name} אינו זמין כרגע", vars: NAME },
  product_not_found: { group: "מוצר", label: "המוצר לא נמצא", default: "המוצר לא נמצא" },

  phone_hidden: { group: "טלפונים", label: "בקשת טלפון כשהמספר חסוי", default: "הקישו מספר טלפון וסולמית" },
  phone_invalid: { group: "טלפונים", label: "מספר לא תקין", default: "המספר שהוקש אינו מספר טלפון תקין" },
  phone_repeated: { group: "טלפונים", label: "מספר שכבר הוקש", default: "המספר הזה כבר הוקש" },
  phone_confirm: {
    group: "טלפונים",
    label: "אישור מספר שהוקש",
    default: "הקשתם {phone} לאישור הקישו 1, להקשה מחדש הקישו 2",
    vars: { phone: "הטלפון (מוקרא ספרה ספרה)" },
  },
  phone_failed: { group: "טלפונים", label: "לא התקבל מספר אחרי כמה ניסיונות", default: "לא התקבל מספר טלפון תקין" },

  payment_not_completed: { group: "תשלום ותקלות", label: "התשלום לא הושלם", default: "התשלום לא הושלם" },
  payment_not_configured: { group: "תשלום ותקלות", label: "הסליקה לא הוגדרה", default: "הסליקה עדיין לא הוגדרה, נסו שוב מאוחר יותר" },
  bad_config: { group: "תשלום ותקלות", label: "שלוחה לא מוגדרת כראוי", default: "השלוחה לא הוגדרה כראוי" },
  general_error: { group: "תשלום ותקלות", label: "תקלה כללית", default: "אירעה תקלה, נסו שוב מאוחר יותר" },
} satisfies Record<string, TextDef>;

export type TextKey = keyof typeof TEXTS;

export function isTextKey(key: string): key is TextKey {
  return Object.hasOwn(TEXTS, key);
}

/** הטקסטים ששונו ללקוח (רק מה ששונה נשמר) */
export function parseTexts(raw: string | null | undefined): Partial<Record<TextKey, string>> {
  try {
    const saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
    const out: Partial<Record<TextKey, string>> = {};
    for (const [k, v] of Object.entries(saved)) if (isTextKey(k) && typeof v === "string" && v.trim()) out[k] = v;
    return out;
  } catch {
    return {};
  }
}

export function textOf(tenant: TenantConfig, key: TextKey): string {
  return parseTexts(tenant.ivr_texts)[key] ?? TEXTS[key].default;
}

/**
 * הופך טקסט עם משתנים לחלקי הודעה לימות.
 * משתנה שהוא מחרוזת נכנס לתוך הטקסט, ומשתנה שהוא חלקי הודעה (מספר, ספרות) מפצל את הטקסט סביבו.
 * משתנה לא מוכר נשאר כמו שהוא.
 */
export function say(template: string, vars: Record<string, string | Part[]> = {}): Part[] {
  const parts: Part[] = [];
  let buffer = "";
  const flush = () => {
    if (buffer.trim()) {
      const part = t(buffer);
      if (part.value) parts.push(part);
    }
    buffer = "";
  };
  let last = 0;
  for (const m of template.matchAll(/\{(\w+)\}/g)) {
    buffer += template.slice(last, m.index);
    last = m.index + m[0].length;
    const v = Object.hasOwn(vars, m[1]!) ? vars[m[1]!]! : m[0];
    if (typeof v === "string") {
      buffer += v;
    } else {
      flush();
      parts.push(...v);
    }
  }
  buffer += template.slice(last);
  flush();
  return parts;
}

/** טקסט של לקוח עם המשתנים, מוכן לימות. override = טקסט שהוגדר בקורס / מוצר עצמו. */
export function sayText(tenant: TenantConfig, key: TextKey, vars: Record<string, string | Part[]> = {}, override?: string | null): Part[] {
  return say(override?.trim() || textOf(tenant, key), vars);
}
