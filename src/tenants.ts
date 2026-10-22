import { phonesTableSql, tenantTablesSql } from "./db/schema";
import type { Env } from "./env";

/** לקוח של הפלטפורמה (למשל זאבי וייס). נשמר בטבלה tenants ומנוהל ממערכת הניהול. */
export interface TenantConfig {
  id: number;
  /** מזהה פנימי באנגלית (ממנו נגזרת קידומת הטבלאות) */
  slug: string;
  /** מספר הלקוח - מופיע בכתובות של ימות (client=...) */
  client_number: number;
  /** שם לתצוגה */
  title: string;
  /** קידומת הטבלאות במסד */
  prefix: string;
  /** מפתח שמוגדר בשלוחות ימות (api_add_0=key=...) */
  api_key: string;
  /** מספר המוסד בנדרים פלוס */
  nedarim_mosad_id: string | null;
  contact_name: string | null;
  contact_phone: string | null;
  notes: string | null;
  /** הגדרות מייל (JSON) - ראו email.ts */
  email_settings: string | null;
  /** טקסטים בשיחה ששונו (JSON) - ראו ivr/texts.ts */
  ivr_texts: string | null;
  is_active: number;
  created_at: string;
}

export const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PREFIX_RE = /^[a-z][a-z0-9_]*_$/;

export function prefixFromSlug(slug: string): string {
  return `${slug.replace(/-/g, "_")}_`;
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

/** מוסיף עמודה אם אינה קיימת. מחזיר true אם נוספה עכשיו. */
async function ensureColumn(db: D1Database, table: string, column: string, ddl: string): Promise<boolean> {
  const exists = await db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = ?").bind(table, column).first();
  if (exists) return false;
  await db.prepare(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`).run();
  return true;
}

function toConfig(row: TenantConfig): TenantConfig {
  if (!SLUG_RE.test(row.slug) || !PREFIX_RE.test(row.prefix)) throw new Error(`Invalid tenant row: ${row.slug}`);
  return row;
}

let ready: Promise<void> | null = null;

/**
 * מכין את המסד בפעם הראשונה בכל מופע של ה-Worker:
 * טבלאות הפלטפורמה (tenants, platform_settings, portal_users), הלקוח הראשון (זאבי וייס),
 * ועמודות שנוספו לטבלאות הלקוחות.
 */
export function ensurePlatform(env: Env): Promise<void> {
  ready ??= setup(env).catch((err) => {
    ready = null;
    throw err;
  });
  return ready;
}

export async function setup(env: Env): Promise<void> {
  const db = env.DB;
  await db
    .prepare(
      `CREATE TABLE IF NOT EXISTS tenants (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        slug TEXT NOT NULL UNIQUE,
        title TEXT NOT NULL,
        prefix TEXT NOT NULL UNIQUE,
        api_key TEXT NOT NULL,
        nedarim_mosad_id TEXT,
        contact_name TEXT,
        contact_phone TEXT,
        notes TEXT,
        is_active INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    )
    .run();

  // הלקוח הראשון, עם המפתח שכבר הוגדר בשלוחות (אם הוגדר בסוד הישן TENANT_KEYS)
  let legacyKey: string | null = null;
  try {
    const keys = JSON.parse(env.TENANT_KEYS ?? "{}") as Record<string, unknown>;
    if (typeof keys["zeevi-weiss"] === "string") legacyKey = keys["zeevi-weiss"];
  } catch {
    // לא מוגדר - נוצר מפתח חדש
  }
  await db
    .prepare(`INSERT OR IGNORE INTO tenants (slug, title, prefix, api_key) VALUES ('zeevi-weiss', 'זאבי וייס', 'zeevi_weiss_', ?)`)
    .bind(legacyKey ?? generateKey())
    .run();

  await ensureColumn(db, "tenants", "client_number", "INTEGER");
  await ensureColumn(db, "tenants", "email_settings", "TEXT");
  await ensureColumn(db, "tenants", "ivr_texts", "TEXT");
  await db.prepare("CREATE UNIQUE INDEX IF NOT EXISTS idx_tenants_client_number ON tenants(client_number)").run();
  // מספר לקוח לכל מי שעדיין אין לו (זאבי וייס מקבל 1)
  while (await db.prepare("SELECT 1 FROM tenants WHERE client_number IS NULL").first()) {
    await db
      .prepare(
        `UPDATE tenants SET client_number = (SELECT COALESCE(MAX(client_number), 0) + 1 FROM tenants)
         WHERE id = (SELECT id FROM tenants WHERE client_number IS NULL ORDER BY id LIMIT 1)`,
      )
      .run();
  }

  await db.batch([
    db.prepare(`CREATE TABLE IF NOT EXISTS platform_settings (key TEXT PRIMARY KEY, value TEXT)`),
    db.prepare(
      `CREATE TABLE IF NOT EXISTS portal_users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        tenant_id INTEGER NOT NULL REFERENCES tenants(id),
        username TEXT NOT NULL UNIQUE,
        display_name TEXT,
        password_hash TEXT NOT NULL,
        password_salt TEXT NOT NULL,
        permissions TEXT NOT NULL DEFAULT '{}',
        is_active INTEGER NOT NULL DEFAULT 1,
        last_login_at TEXT,
        created_at TEXT NOT NULL DEFAULT (datetime('now'))
      )`,
    ),
  ]);

  for (const tenant of await listTenants(db)) {
    const table = `${tenant.prefix}courses`;
    const exists = await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first();
    if (!exists) continue;
    await ensureColumn(db, table, "access_days", "INTEGER");
    // מה קורה למי שכבר רכש כשהקורס לא פעיל: keep = ממשיך לקבל גישה, block = נחסם (ושומע הסבר)
    await ensureColumn(db, table, "on_inactive", "TEXT NOT NULL DEFAULT 'keep'");
    await migrateItemSettings(db, tenant);

    // בטבלה המקורית מותרים רק 2 טלפונים (slot IN (1,2)). בונים אותה מחדש בלי ההגבלה, עם כל הנתונים.
    const phones = `${tenant.prefix}subscription_phones`;
    const def = await db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").bind(phones).first<{ sql: string }>();
    if (def && /slot IN \(1,\s*2\)/.test(def.sql)) {
      const tmp = `${phones}_new`;
      await db.batch([
        db.prepare(`DROP TABLE IF EXISTS ${tmp}`),
        db.prepare(phonesTableSql(tmp, tenant.prefix)),
        db.prepare(`INSERT INTO ${tmp} (id, subscription_id, phone, slot, created_at) SELECT id, subscription_id, phone, slot, created_at FROM ${phones}`),
        db.prepare(`DROP TABLE ${phones}`),
        db.prepare(`ALTER TABLE ${tmp} RENAME TO ${phones}`),
        db.prepare(`CREATE INDEX IF NOT EXISTS idx_${tenant.prefix}sub_phones_phone ON ${phones}(phone)`),
      ]);
    }
  }
}

/**
 * הגדרות לכל קורס ומוצר: טקסטים משלו, האם אפשר לבחור טלפון אחר, ומה קורה אחרי רכישה (מייל).
 * כשהעמודות נוספות בפעם הראשונה, ממירים את ההגדרות הישנות (סוג מוצר, מייל לפי סוג אירוע).
 */
async function migrateItemSettings(db: D1Database, tenant: TenantConfig): Promise<void> {
  const courses = `${tenant.prefix}courses`;
  const products = `${tenant.prefix}products`;
  for (const table of [courses, products]) {
    for (const col of ["offer_text", "success_text", "email_to", "email_subject", "email_body"]) await ensureColumn(db, table, col, "TEXT");
  }
  // בקורס: עד עכשיו תמיד אפשר היה לבחור טלפון אחר. במוצר: ברירת המחדל - רק המספר שממנו התקשרו
  await ensureColumn(db, courses, "ask_phone", "INTEGER NOT NULL DEFAULT 1");
  if (await ensureColumn(db, products, "ask_phone", "INTEGER NOT NULL DEFAULT 0")) {
    await db.prepare(`UPDATE ${products} SET ask_phone = 1 WHERE type = 'phone_meeting'`).run();
    await db
      .prepare(`UPDATE ${products} SET success_text = CASE type WHEN 'meeting' THEN ?1 ELSE ?2 END WHERE type IN ('meeting','phone_meeting') AND success_text IS NULL`)
      .bind("הפגישה נרכשה בהצלחה, ניצור איתך קשר לתיאום המועד", "הפגישה הטלפונית נרכשה בהצלחה, ניצור איתך קשר לתיאום המועד")
      .run();
  }

  // מייל: בגרסה הקודמת נשלח לפי סוג (פגישות כן, מוצרים וקורסים לא - אלא אם הופעל)
  type OldEvents = Record<string, { enabled?: boolean; recipients?: string } | undefined>;
  let events: OldEvents | null = null;
  try {
    events = (JSON.parse(tenant.email_settings ?? "{}") as { events?: OldEvents }).events ?? null;
  } catch {
    events = null;
  }
  const was = (key: string, fallback: boolean) => (events?.[key]?.enabled ?? fallback ? 1 : 0);
  if (await ensureColumn(db, courses, "send_email", "INTEGER NOT NULL DEFAULT 1")) {
    await db.prepare(`UPDATE ${courses} SET send_email = ?, email_to = NULLIF(?, '')`).bind(was("course", false), events?.course?.recipients ?? "").run();
  }
  if (await ensureColumn(db, products, "send_email", "INTEGER NOT NULL DEFAULT 1")) {
    for (const [type, fallback] of [["product", false], ["meeting", true], ["phone_meeting", true]] as const) {
      await db
        .prepare(`UPDATE ${products} SET send_email = ?, email_to = NULLIF(?, '') WHERE type = ?`)
        .bind(was(type, fallback), events?.[type]?.recipients ?? "", type)
        .run();
    }
  }
}

export async function listTenants(db: D1Database): Promise<TenantConfig[]> {
  const rows = await db.prepare("SELECT * FROM tenants ORDER BY id").all<TenantConfig>();
  return rows.results.map(toConfig);
}

export async function getTenantByClient(db: D1Database, clientNumber: string | null): Promise<TenantConfig | null> {
  if (!clientNumber || !/^\d{1,9}$/.test(clientNumber)) return null;
  const row = await db.prepare("SELECT * FROM tenants WHERE client_number = ?").bind(Number(clientNumber)).first<TenantConfig>();
  return row ? toConfig(row) : null;
}

export async function getTenantById(db: D1Database, id: number): Promise<TenantConfig | null> {
  const row = await db.prepare("SELECT * FROM tenants WHERE id = ?").bind(id).first<TenantConfig>();
  return row ? toConfig(row) : null;
}

export async function getTenant(db: D1Database, slug: string): Promise<TenantConfig | null> {
  if (!SLUG_RE.test(slug)) return null;
  const row = await db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<TenantConfig>();
  return row ? toConfig(row) : null;
}

export interface TenantInput {
  slug: string;
  title: string;
  client_number?: number | null;
  nedarim_mosad_id?: string | null;
  contact_name?: string | null;
  contact_phone?: string | null;
  notes?: string | null;
}

/** יוצר לקוח חדש: שורה ב-tenants ואת כל הטבלאות שלו עם הקידומת. */
export async function createTenant(db: D1Database, input: TenantInput): Promise<TenantConfig> {
  if (!SLUG_RE.test(input.slug) || input.slug.length > 40) throw new Error("INVALID_SLUG");
  const prefix = prefixFromSlug(input.slug);
  if (!PREFIX_RE.test(prefix) || prefix.startsWith("sqlite_") || prefix === "tenants_") throw new Error("INVALID_SLUG");
  if (await getTenant(db, input.slug)) throw new Error("SLUG_EXISTS");

  if (input.client_number && (await db.prepare("SELECT 1 FROM tenants WHERE client_number = ?").bind(input.client_number).first())) {
    throw new Error("CLIENT_NUMBER_EXISTS");
  }

  await db.batch(tenantTablesSql(prefix).map((sql) => db.prepare(sql)));
  await db
    .prepare(
      `INSERT INTO tenants (slug, title, prefix, api_key, client_number, nedarim_mosad_id, contact_name, contact_phone, notes)
       VALUES (?, ?, ?, ?, COALESCE(?, (SELECT COALESCE(MAX(client_number), 0) + 1 FROM tenants)), ?, ?, ?, ?)`,
    )
    .bind(
      input.slug,
      input.title,
      prefix,
      generateKey(),
      input.client_number ?? null,
      input.nedarim_mosad_id ?? null,
      input.contact_name ?? null,
      input.contact_phone ?? null,
      input.notes ?? null,
    )
    .run();
  return (await getTenant(db, input.slug))!;
}

const EDITABLE = ["title", "client_number", "nedarim_mosad_id", "contact_name", "contact_phone", "notes", "is_active", "email_settings", "ivr_texts"] as const;

export async function updateTenant(db: D1Database, slug: string, values: Partial<Record<(typeof EDITABLE)[number], string | number | null>>): Promise<boolean> {
  const cols = EDITABLE.filter((c) => c in values);
  if (cols.length === 0) return false;
  const res = await db
    .prepare(`UPDATE tenants SET ${cols.map((c) => `${c} = ?`).join(", ")} WHERE slug = ?`)
    .bind(...cols.map((c) => values[c] ?? null), slug)
    .run();
  return res.meta.changes > 0;
}

export async function rotateTenantKey(db: D1Database, slug: string): Promise<string | null> {
  const key = generateKey();
  const res = await db.prepare("UPDATE tenants SET api_key = ? WHERE slug = ?").bind(key, slug).run();
  return res.meta.changes > 0 ? key : null;
}

/** השוואה בזמן קבוע של המפתח שנשלח מהשלוחה. */
export async function keyMatches(tenant: TenantConfig, provided: string | null): Promise<boolean> {
  if (!provided || !tenant.api_key) return false;
  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(tenant.api_key)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
