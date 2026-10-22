import type { TenantDb } from "./db/repo";
import type { ItemSettings } from "./db/types";
import { DEFAULT_EMAIL_FOOTER, emailSender, getSetting } from "./platform";

/** משתנים שאפשר לשים בנושא ובתוכן: {name} */
export const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "item", label: "מה נרכש (שם הקורס / המוצר)" },
  { key: "kind", label: "סוג (קורס / מוצר)" },
  { key: "price", label: "מחיר" },
  { key: "buyer_phone", label: "הטלפון שממנו התקשרו" },
  { key: "phones", label: "טלפונים (עם גישה לקורס / ליצירת קשר)" },
  { key: "validity", label: "תוקף הגישה" },
  { key: "date", label: "תאריך" },
  { key: "time", label: "שעה" },
  { key: "reference", label: "מספר אסמכתא" },
];

export interface EmailSettings {
  /** מתג ראשי: בלי זה לא נשלח שום מייל */
  enabled: boolean;
  /** נמענים לכל ההתראות, מופרדים בפסיק */
  recipients: string;
  /** תבנית ברירת המחדל לכל רכישה (קורס או מוצר יכולים להגדיר משלהם) */
  subject: string;
  body: string;
  /** להוסיף למייל טבלה מסודרת עם פרטי הרכישה */
  show_details: boolean;
}

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  enabled: true,
  recipients: "",
  subject: "רכישה חדשה: {item}",
  body: "שלום,\n\nהתקבלה רכישה חדשה בטלפון של {item}.",
  show_details: true,
};

/** פרטי רכישה שנשלחים במייל */
export interface PurchaseVars {
  kind: "course" | "product";
  item: string;
  price: string;
  buyer_phone: string;
  /** בקורס: הטלפונים שקיבלו גישה. במוצר: הטלפון ליצירת קשר */
  phones: string;
  validity?: string;
  reference: string;
}

const KIND_LABEL = { course: "קורס", product: "מוצר" } as const;

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function splitEmails(list: string | null | undefined): string[] {
  return (list ?? "")
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

/** מחזיר את הכתובת הראשונה שאינה תקינה, או null */
export function invalidEmail(list: string | null | undefined): string | null {
  return splitEmails(list).find((e) => !EMAIL_RE.test(e)) ?? null;
}

export function parseEmailSettings(raw: string | null): EmailSettings {
  let saved: Record<string, unknown> = {};
  try {
    saved = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
  } catch {
    saved = {};
  }
  const settings: EmailSettings = { ...DEFAULT_EMAIL_SETTINGS };
  for (const key of ["recipients", "subject", "body"] as const) {
    if (typeof saved[key] === "string" && (saved[key] as string).trim()) settings[key] = saved[key] as string;
  }
  if (typeof saved.enabled === "boolean") settings.enabled = saved.enabled;
  else if (saved.events && typeof saved.events === "object") {
    // הגדרות מהגרסה הקודמת (מייל לפי סוג אירוע): פעיל אם אחד האירועים היה פעיל
    settings.enabled = Object.values(saved.events as Record<string, { enabled?: boolean }>).some((e) => e?.enabled);
  }
  if (typeof saved.show_details === "boolean") settings.show_details = saved.show_details;
  return settings;
}

/** בדיקת הגדרות שהגיעו ממערכת הניהול. מחזיר הגדרות נקיות או שגיאה בעברית. */
export function isEmail(s: string): boolean {
  return EMAIL_RE.test(s);
}

export function validateEmailSettings(input: unknown): { settings: EmailSettings } | { error: string } {
  if (!input || typeof input !== "object") return { error: "הגדרות לא תקינות" };
  const body = input as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const settings: EmailSettings = {
    enabled: body.enabled !== false,
    recipients: str(body.recipients, 1000),
    subject: str(body.subject, 200) || DEFAULT_EMAIL_SETTINGS.subject,
    body: str(body.body, 5000) || DEFAULT_EMAIL_SETTINGS.body,
    show_details: body.show_details !== false,
  };
  const bad = invalidEmail(settings.recipients);
  if (bad) return { error: `כתובת נמען לא תקינה: ${bad}` };
  return { settings };
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (Object.hasOwn(vars, k) ? vars[k]! : m));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function israelDateTime(now = new Date()): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return { date, time };
}

const splitPhones = (list: string | undefined) => (list ?? "").split(/[,\s]+/).filter(Boolean);

/** שורות טבלת פרטי הרכישה */
function detailRows(v: Record<string, string>, kind: PurchaseVars["kind"]): [string, string][] {
  const rows: [string, string][] = [
    [KIND_LABEL[kind], v.item ?? ""],
    ["מחיר", v.price ?? ""],
  ];
  // טלפון הרוכש מוצג רק אם הוא לא כבר ברשימת הטלפונים (בדרך כלל הוא שם)
  const phones = splitPhones(v.phones);
  if (v.buyer_phone && !phones.includes(v.buyer_phone)) rows.push(["הטלפון שממנו התקשרו", v.buyer_phone]);
  rows.push([kind === "course" ? (phones.length > 1 ? "טלפונים עם גישה" : "טלפון עם גישה") : "טלפון ליצירת קשר", phones.join(", ")]);
  if (kind === "course") rows.push(["תוקף", v.validity ?? ""]);
  rows.push(["מועד הרכישה", `${v.date} בשעה ${v.time}`], ["מספר אסמכתא", v.reference ?? ""]);
  return rows.filter(([, value]) => value.trim() !== "");
}

/** עיצוב המייל: כותרת, הטקסט החופשי, טבלת פרטים, ושורת סיום. */
export function emailHtml(o: { subject: string; body: string; details: [string, string][] | null; footer: string }): string {
  const paragraphs = escapeHtml(o.body)
    .split(/\n{2,}/)
    .filter((p) => p.trim())
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const details = o.details?.length
    ? `<tr><td style="padding:4px 32px 28px">
<div style="font-size:13px;font-weight:bold;color:#6366f1;margin:0 0 10px">פרטי הרכישה</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="border:1px solid #e5e7eb;border-radius:12px;border-collapse:separate;overflow:hidden">
${o.details
  .map(
    ([k, v], i) =>
      `<tr><td style="padding:11px 16px;background:${i % 2 ? "#ffffff" : "#f8fafc"};color:#64748b;font-size:14px;width:38%;text-align:right">${escapeHtml(k)}</td><td style="padding:11px 16px;background:${i % 2 ? "#ffffff" : "#f8fafc"};color:#0f172a;font-size:14px;font-weight:bold;text-align:right">${escapeHtml(v)}</td></tr>`,
  )
  .join("\n")}
</table></td></tr>`
    : "";
  return `<!doctype html><html lang="he" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f1f5f9;font-family:Arial,Helvetica,sans-serif;direction:rtl">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f1f5f9;padding:28px 12px"><tr><td align="center">
<table role="presentation" width="600" cellpadding="0" cellspacing="0" style="max-width:600px;width:100%;background:#ffffff;border-radius:16px;overflow:hidden;box-shadow:0 2px 10px rgba(15,23,42,.06)">
<tr><td style="background:#4f46e5;background-image:linear-gradient(135deg,#4f46e5,#7c3aed);padding:26px 32px;text-align:right">
<div style="color:#ffffff;font-size:22px;font-weight:bold;line-height:1.35">${escapeHtml(o.subject)}</div>
</td></tr>
<tr><td style="padding:28px 32px 10px;color:#1e293b;font-size:15px;line-height:1.75;text-align:right">${paragraphs}</td></tr>
${details}
<tr><td style="padding:16px 32px;background:#f8fafc;border-top:1px solid #eef2f7;color:#94a3b8;font-size:12px;text-align:right">${escapeHtml(o.footer)}</td></tr>
</table></td></tr></table></body></html>`;
}

export interface BuiltEmail {
  subject: string;
  html: string;
  text: string;
}

/**
 * בונה את המייל לרכישה: התבנית של הפריט אם הוגדרה, אחרת התבנית הכללית.
 * footer = השורה בתחתית המייל (הגדרות מערכת של המנהל).
 */
export function buildEmail(
  settings: EmailSettings,
  item: ItemSettings,
  purchase: PurchaseVars,
  opts: { test?: boolean; now?: Date; footer?: string } = {},
): BuiltEmail {
  const footer = opts.footer ?? DEFAULT_EMAIL_FOOTER;
  const vars: Record<string, string> = {
    // שם הלקוח לא מופיע במייל. {client} מתבנית ישנה פשוט נעלם
    client: "",
    ...israelDateTime(opts.now),
    ...purchase,
    validity: purchase.validity ?? "",
    kind: KIND_LABEL[purchase.kind],
    // שמות מהגרסה הקודמת, כדי שתבניות ישנות ימשיכו לעבוד
    product: purchase.item,
    course: purchase.item,
    contact_phone: purchase.phones,
  };
  const subject = (opts.test ? "[בדיקה] " : "") + renderTemplate(item.email_subject?.trim() || settings.subject, vars);
  const body = renderTemplate(item.email_body?.trim() || settings.body, vars);
  const details = settings.show_details ? detailRows(vars, purchase.kind) : null;
  const text = [body, ...(details ? ["", ...details.map(([k, v]) => `${k}: ${v}`)] : []), "", footer].join("\n");
  return { subject, html: emailHtml({ subject, body, details, footer }), text };
}

export const SAMPLE_PURCHASE: PurchaseVars = {
  kind: "course",
  item: "גמרא עיון",
  price: "250 ₪",
  buyer_phone: "0501234567",
  phones: "0501234567, 0527654321",
  validity: "365 ימים",
  reference: "1234",
};

export interface SendResult {
  ok: boolean;
  id?: string;
  error?: string;
}

/** שליחה דרך Resend (POST https://api.resend.com/emails). */
export async function sendEmail(
  apiKey: string,
  msg: { from: string; to: string[]; subject: string; html: string; text: string; replyTo?: string; idempotencyKey?: string },
): Promise<SendResult> {
  const headers: Record<string, string> = { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" };
  if (msg.idempotencyKey) headers["Idempotency-Key"] = msg.idempotencyKey;
  const res = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers,
    body: JSON.stringify({
      from: msg.from,
      to: msg.to,
      subject: msg.subject,
      html: msg.html,
      text: msg.text,
      ...(msg.replyTo ? { reply_to: msg.replyTo } : {}),
    }),
  });
  const data = (await res.json().catch(() => ({}))) as { id?: string; message?: string; name?: string };
  if (!res.ok) return { ok: false, error: data.message ?? `Resend ${res.status}` };
  return { ok: true, id: data.id };
}

/**
 * שולח מייל על רכישה לפי ההגדרות הכלליות וההגדרות של הקורס / המוצר. לא זורק שגיאות - התוצאה נרשמת ביומן.
 * test=true: שליחת בדיקה גם אם המיילים כבויים.
 */
export async function notify(
  db: TenantDb,
  item: ItemSettings,
  purchase: PurchaseVars,
  opts: { idempotencyKey?: string; test?: boolean; overrideTo?: string[] } = {},
): Promise<SendResult> {
  const settings = parseEmailSettings(db.tenant.email_settings);
  const skip = async (error: string, log = true): Promise<SendResult> => {
    if (log && !opts.test) await db.log("system", null, "email_skipped", { item: purchase.item, reason: error }).catch(() => {});
    return { ok: false, error };
  };
  if (!opts.test && (!settings.enabled || item.send_email === 0)) return skip("שליחת מייל כבויה", false);

  const apiKey = await getSetting(db.db, "resend_api_key");
  if (!apiKey) return skip("לא הוגדר מפתח Resend (הגדרות מערכת)");
  const sender = await emailSender(db.db);
  if (!sender.from_email) return skip("לא הוגדרה כתובת שולח (הגדרות מערכת)");
  const to = opts.overrideTo ?? [...new Set([...splitEmails(settings.recipients), ...splitEmails(item.email_to)])];
  if (to.length === 0) return skip("לא הוגדרו נמענים");

  const email = buildEmail(settings, item, purchase, { test: opts.test, footer: sender.footer });
  const from = sender.from_name ? `${sender.from_name.replace(/[<>"]/g, "")} <${sender.from_email}>` : sender.from_email;

  let result: SendResult;
  try {
    result = await sendEmail(apiKey, { from, to, ...email, replyTo: sender.reply_to || undefined, idempotencyKey: opts.idempotencyKey });
  } catch (err) {
    result = { ok: false, error: String(err) };
  }
  await db
    .log("system", null, result.ok ? "email_sent" : "email_failed", { item: purchase.item, to, subject: email.subject, test: !!opts.test, id: result.id, error: result.error })
    .catch(() => {});
  return result;
}
