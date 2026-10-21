/** הגדרות כלליות של הפלטפורמה (לא של לקוח מסוים), בטבלה platform_settings. */
export type PlatformKey = "resend_api_key";

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
