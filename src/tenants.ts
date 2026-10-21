import { tenantTablesSql } from "./db/schema";
import type { Env } from "./env";

/** לקוח של הפלטפורמה (למשל זאבי וייס). נשמר בטבלה tenants ומנוהל ממערכת הניהול. */
export interface TenantConfig {
  id: number;
  /** המזהה שמופיע בנתיב ה-URL */
  slug: string;
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
  is_active: number;
  created_at: string;
  /** כמה שעות רכישה ממתינה תקפה */
  pendingTtlHours: number;
}

export const SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;
const PREFIX_RE = /^[a-z][a-z0-9_]*_$/;
const PENDING_TTL_HOURS = 24;

export function prefixFromSlug(slug: string): string {
  return `${slug.replace(/-/g, "_")}_`;
}

export function generateKey(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
}

function toConfig(row: Omit<TenantConfig, "pendingTtlHours">): TenantConfig {
  if (!SLUG_RE.test(row.slug) || !PREFIX_RE.test(row.prefix)) throw new Error(`Invalid tenant row: ${row.slug}`);
  return { ...row, pendingTtlHours: PENDING_TTL_HOURS };
}

let ready: Promise<void> | null = null;

/**
 * מכין את המסד בפעם הראשונה בכל מופע של ה-Worker:
 * טבלת tenants, הלקוח הראשון (זאבי וייס) ועמודת access_days בקורסים.
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

  for (const tenant of await listTenants(db)) {
    const table = `${tenant.prefix}courses`;
    const exists = await db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").bind(table).first();
    if (!exists) continue;
    const col = await db.prepare("SELECT 1 FROM pragma_table_info(?) WHERE name = 'access_days'").bind(table).first();
    if (!col) await db.prepare(`ALTER TABLE ${table} ADD COLUMN access_days INTEGER`).run();
  }
}

export async function listTenants(db: D1Database): Promise<TenantConfig[]> {
  const rows = await db.prepare("SELECT * FROM tenants ORDER BY id").all<Omit<TenantConfig, "pendingTtlHours">>();
  return rows.results.map(toConfig);
}

export async function getTenant(db: D1Database, slug: string): Promise<TenantConfig | null> {
  if (!SLUG_RE.test(slug)) return null;
  const row = await db.prepare("SELECT * FROM tenants WHERE slug = ?").bind(slug).first<Omit<TenantConfig, "pendingTtlHours">>();
  return row ? toConfig(row) : null;
}

export interface TenantInput {
  slug: string;
  title: string;
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

  await db.batch(tenantTablesSql(prefix).map((sql) => db.prepare(sql)));
  await db
    .prepare(
      `INSERT INTO tenants (slug, title, prefix, api_key, nedarim_mosad_id, contact_name, contact_phone, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .bind(input.slug, input.title, prefix, generateKey(), input.nedarim_mosad_id ?? null, input.contact_name ?? null, input.contact_phone ?? null, input.notes ?? null)
    .run();
  return (await getTenant(db, input.slug))!;
}

const EDITABLE = ["title", "nedarim_mosad_id", "contact_name", "contact_phone", "notes", "is_active"] as const;

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
