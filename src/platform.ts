/** הגדרות כלליות של הפלטפורמה (לא של לקוח מסוים), בטבלה platform_settings. */
export type PlatformKey = "resend_api_key" | "email_footer" | "email_from_name" | "email_from_email" | "email_reply_to";

/** השורה בתחתית כל מייל, כשמנהל המערכת לא הגדיר אחרת */
export const DEFAULT_EMAIL_FOOTER = "מייל אוטומטי · פותח ע״י SMT";

export async function emailFooter(db: D1Database): Promise<string> {
  return (await getSetting(db, "email_footer"))?.trim() || DEFAULT_EMAIL_FOOTER;
}

/** השולח של כל המיילים, לכל הלקוחות - נקבע בהגדרות המערכת של המנהל */
export interface EmailSender {
  from_name: string;
  /** חייבת להיות בדומיין שמאומת ב-Resend */
  from_email: string;
  reply_to: string;
  footer: string;
}

export async function emailSender(db: D1Database): Promise<EmailSender> {
  const rows = await db
    .prepare("SELECT key, value FROM platform_settings WHERE key IN ('email_from_name', 'email_from_email', 'email_reply_to', 'email_footer')")
    .all<{ key: PlatformKey; value: string | null }>();
  const get = (k: PlatformKey) => rows.results.find((r) => r.key === k)?.value?.trim() ?? "";
  return { from_name: get("email_from_name"), from_email: get("email_from_email"), reply_to: get("email_reply_to"), footer: get("email_footer") || DEFAULT_EMAIL_FOOTER };
}

export async function getSetting(db: D1Database, key: PlatformKey): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM platform_settings WHERE key = ?").bind(key).first<{ value: string | null }>();
  return row?.value ?? null;
}

export async function setSetting(db: D1Database, key: PlatformKey, value: string | null): Promise<void> {
  await db
    .prepare("INSERT INTO platform_settings (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value")
    .bind(key, value)
    .run();
}

/** מציג רק את תחילת וסוף המפתח */
export function maskSecret(value: string | null): string | null {
  if (!value) return null;
  return value.length <= 8 ? "••••" : `${value.slice(0, 4)}••••${value.slice(-4)}`;
}
