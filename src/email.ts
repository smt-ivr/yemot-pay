import type { TenantDb } from "./db/repo";
import { getSetting } from "./platform";

/** האירועים שאפשר לשלוח עליהם מייל */
export type EmailEvent = "meeting" | "phone_meeting" | "product" | "course";

export const EMAIL_EVENTS: { key: EmailEvent; label: string }[] = [
  { key: "meeting", label: "נרכשה פגישה" },
  { key: "phone_meeting", label: "נרכשה פגישה טלפונית" },
  { key: "product", label: "נרכש מוצר" },
  { key: "course", label: "נרכש קורס" },
];

/** משתנים שאפשר לשים בנושא ובתוכן: {name} */
export const PLACEHOLDERS: { key: string; label: string }[] = [
  { key: "client", label: "שם העסק" },
  { key: "product", label: "שם המוצר / הפגישה" },
  { key: "course", label: "שם הקורס" },
  { key: "price", label: "מחיר" },
  { key: "buyer_phone", label: "הטלפון שממנו התקשרו" },
  { key: "contact_phone", label: "טלפון לתיאום (בפגישה טלפונית)" },
  { key: "phones", label: "הטלפונים שקיבלו גישה לקורס" },
  { key: "validity", label: "תוקף הגישה" },
  { key: "date", label: "תאריך" },
  { key: "time", label: "שעה" },
  { key: "reference", label: "מספר הזמנה / מנוי" },
];

export interface EventTemplate {
  enabled: boolean;
  /** נמענים נוספים לאירוע הזה בלבד (בנוסף לנמענים הכלליים) */
  recipients: string;
  subject: string;
  body: string;
}

export interface EmailSettings {
  from_name: string;
  /** כתובת השולח - חייבת להיות בדומיין שמאומת ב-Resend */
  from_email: string;
  reply_to: string;
  /** נמענים לכל ההתראות, מופרדים בפסיק */
  recipients: string;
  events: Record<EmailEvent, EventTemplate>;
}

const SIGNATURE = "\n\nנשלח אוטומטית ממערכת הרכישות הטלפונית של {client}.";

export const DEFAULT_EMAIL_SETTINGS: EmailSettings = {
  from_name: "",
  from_email: "",
  reply_to: "",
  recipients: "",
  events: {
    meeting: {
      enabled: true,
      recipients: "",
      subject: "פגישה חדשה: {product}",
      body: "שלום,\n\nנרכשה פגישה חדשה בטלפון.\n\nפגישה: {product}\nמחיר: {price}\nטלפון הרוכש: {buyer_phone}\nמועד הרכישה: {date} בשעה {time}\nמספר הזמנה: {reference}\n\nיש ליצור קשר עם הרוכש לתיאום מועד." + SIGNATURE,
    },
    phone_meeting: {
      enabled: true,
      recipients: "",
      subject: "פגישה טלפונית חדשה: {product}",
      body: "שלום,\n\nנרכשה פגישה טלפונית חדשה.\n\nפגישה: {product}\nמחיר: {price}\nטלפון לתיאום: {contact_phone}\nהטלפון שממנו התקשרו: {buyer_phone}\nמועד הרכישה: {date} בשעה {time}\nמספר הזמנה: {reference}\n\nיש לחזור לרוכש לתיאום מועד." + SIGNATURE,
    },
    product: {
      enabled: false,
      recipients: "",
      subject: "רכישה חדשה: {product}",
      body: "שלום,\n\nנרכש מוצר בטלפון.\n\nמוצר: {product}\nמחיר: {price}\nטלפון הרוכש: {buyer_phone}\nמועד הרכישה: {date} בשעה {time}\nמספר הזמנה: {reference}" + SIGNATURE,
    },
    course: {
      enabled: false,
      recipients: "",
      subject: "מנוי חדש לקורס {course}",
      body: "שלום,\n\nנרכש מנוי לקורס בטלפון.\n\nקורס: {course}\nמחיר: {price}\nתוקף: {validity}\nטלפונים עם גישה: {phones}\nהטלפון שממנו התקשרו: {buyer_phone}\nמועד הרכישה: {date} בשעה {time}\nמספר מנוי: {reference}" + SIGNATURE,
    },
  },
};

const EMAIL_RE = /^[^\s@<>,;]+@[^\s@<>,;]+\.[^\s@<>,;]+$/;

export function splitEmails(list: string): string[] {
  return list
    .split(/[,;\s]+/)
    .map((e) => e.trim())
    .filter(Boolean);
}

export function parseEmailSettings(raw: string | null): EmailSettings {
  let saved: Partial<EmailSettings> = {};
  try {
    saved = raw ? (JSON.parse(raw) as Partial<EmailSettings>) : {};
  } catch {
    saved = {};
  }
  const events = { ...DEFAULT_EMAIL_SETTINGS.events };
  for (const { key } of EMAIL_EVENTS) events[key] = { ...DEFAULT_EMAIL_SETTINGS.events[key], ...(saved.events?.[key] ?? {}) };
  return { ...DEFAULT_EMAIL_SETTINGS, ...saved, events };
}

/** בדיקת הגדרות שהגיעו ממערכת הניהול. מחזיר הגדרות נקיות או שגיאה בעברית. */
export function validateEmailSettings(input: unknown): { settings: EmailSettings } | { error: string } {
  if (!input || typeof input !== "object") return { error: "הגדרות לא תקינות" };
  const body = input as Record<string, unknown>;
  const str = (v: unknown, max: number) => (typeof v === "string" ? v.trim().slice(0, max) : "");
  const settings = parseEmailSettings(null);
  settings.from_name = str(body.from_name, 100);
  settings.from_email = str(body.from_email, 200);
  settings.reply_to = str(body.reply_to, 200);
  settings.recipients = str(body.recipients, 1000);

  if (settings.from_email && !EMAIL_RE.test(settings.from_email)) return { error: "כתובת השולח אינה תקינה" };
  if (settings.reply_to && !EMAIL_RE.test(settings.reply_to)) return { error: "כתובת המענה אינה תקינה" };
  for (const e of splitEmails(settings.recipients)) if (!EMAIL_RE.test(e)) return { error: `כתובת נמען לא תקינה: ${e}` };

  const events = (body.events ?? {}) as Record<string, Record<string, unknown>>;
  for (const { key, label } of EMAIL_EVENTS) {
    const e = events[key] ?? {};
    const t: EventTemplate = {
      enabled: e.enabled === true,
      recipients: str(e.recipients, 1000),
      subject: str(e.subject, 200) || DEFAULT_EMAIL_SETTINGS.events[key].subject,
      body: str(e.body, 5000) || DEFAULT_EMAIL_SETTINGS.events[key].body,
    };
    for (const r of splitEmails(t.recipients)) if (!EMAIL_RE.test(r)) return { error: `כתובת נמען לא תקינה ב"${label}": ${r}` };
    settings.events[key] = t;
  }
  return { settings };
}

export function renderTemplate(template: string, vars: Record<string, string>): string {
  return template.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function emailHtml(title: string, body: string): string {
  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  return `<!doctype html><html lang="he" dir="rtl"><body style="margin:0;background:#f4f6fb;font-family:Arial,Helvetica,sans-serif">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f6fb;padding:24px 0"><tr><td align="center">
<table role="presentation" width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;background:#ffffff;border-radius:12px;overflow:hidden;border:1px solid #e5e8f0">
<tr><td style="background:#4f46e5;color:#ffffff;padding:18px 24px;font-size:18px;font-weight:bold;text-align:right">${escapeHtml(title)}</td></tr>
<tr><td style="padding:24px;color:#1f2937;font-size:15px;line-height:1.7;text-align:right;direction:rtl">${paragraphs}</td></tr>
</table></td></tr></table></body></html>`;
}

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

export function israelDateTime(now = new Date()): { date: string; time: string } {
  const date = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", day: "2-digit", month: "2-digit", year: "numeric" }).format(now);
  const time = new Intl.DateTimeFormat("he-IL", { timeZone: "Asia/Jerusalem", hour: "2-digit", minute: "2-digit", hour12: false }).format(now);
  return { date, time };
}

/**
 * שולח מייל על אירוע לפי הגדרות הלקוח. לא זורק שגיאות - התוצאה נרשמת ביומן.
 * test=true: שליחת בדיקה גם אם האירוע כבוי.
 */
export async function notify(
  db: TenantDb,
  event: EmailEvent,
  vars: Record<string, string>,
  opts: { idempotencyKey?: string; test?: boolean; overrideTo?: string[] } = {},
): Promise<SendResult> {
  const settings = parseEmailSettings(db.tenant.email_settings);
  const tpl = settings.events[event];
  const fail = async (error: string): Promise<SendResult> => {
    if (!opts.test) await db.log("system", null, "email_skipped", { event, reason: error }).catch(() => {});
    return { ok: false, error };
  };
  if (!tpl.enabled && !opts.test) return { ok: false, error: "האירוע כבוי" };

  const apiKey = await getSetting(db.db, "resend_api_key");
  if (!apiKey) return fail("לא הוגדר מפתח Resend (הגדרות מערכת)");
  if (!settings.from_email) return fail("לא הוגדרה כתובת שולח");
  const to = opts.overrideTo ?? [...new Set([...splitEmails(settings.recipients), ...splitEmails(tpl.recipients)])];
  if (to.length === 0) return fail("לא הוגדרו נמענים");

  const allVars = { client: db.tenant.title, ...israelDateTime(), ...vars };
  const subject = (opts.test ? "[בדיקה] " : "") + renderTemplate(tpl.subject, allVars);
  const text = renderTemplate(tpl.body, allVars);
  const from = settings.from_name ? `${settings.from_name.replace(/[<>"]/g, "")} <${settings.from_email}>` : settings.from_email;

  let result: SendResult;
  try {
    result = await sendEmail(apiKey, {
      from,
      to,
      subject,
      text,
      html: emailHtml(subject, text),
      replyTo: settings.reply_to || undefined,
      idempotencyKey: opts.idempotencyKey,
    });
  } catch (err) {
    result = { ok: false, error: String(err) };
  }
  await db
    .log("system", null, result.ok ? "email_sent" : "email_failed", { event, to, subject, test: !!opts.test, id: result.id, error: result.error })
    .catch(() => {});
  return result;
}
