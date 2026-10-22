import { TenantDb } from "../db/repo";
import { PLACEHOLDERS, SAMPLE_PURCHASE, buildEmail, invalidEmail, notify, parseEmailSettings, splitEmails, validateEmailSettings, type PurchaseVars } from "../email";
import type { ItemSettings } from "../db/types";
import { TEXTS, isTextKey, parseTexts } from "../ivr/texts";
import type { Env } from "../env";
import { addDays, normalizePhone, todayIso } from "../lib/util";
import { DEFAULT_EMAIL_FOOTER, emailFooter, getSetting, maskSecret, setSetting } from "../platform";
import { SLUG_RE, createTenant, getTenant, listTenants, rotateTenantKey, updateTenant, type TenantConfig } from "../tenants";
import { ENTITIES, getEntity, type Entity, type EntityName, type Field } from "./entities";
import {
  SECTIONS,
  can,
  clearSessionCookie,
  createSessionCookie,
  getPrincipal,
  hashPassword,
  login,
  parsePermissions,
  type Principal,
  type Section,
} from "./session";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const error = (message: string, status = 400) => json({ error: message }, status);
const forbidden = () => error("אין לך הרשאה לפעולה הזו", 403);

/**
 * API של מערכת הניהול. path הוא הנתיב אחרי /admin/api.
 * cookiePath הוא נתיב מערכת הניהול (כולל תחילית כמו /yemot-pay) לעוגיית ההתחברות.
 *
 * מנהל המערכת רואה הכל. משתמש של לקוח (אזור אישי) רואה רק את הלקוח שלו,
 * ורק את האזורים שקיבל עליהם הרשאה (צפייה / עריכה).
 */
export async function handleAdminApi(request: Request, env: Env, path: string, cookiePath: string): Promise<Response> {
  const method = request.method;
  const isMutation = method !== "GET";
  if (isMutation && !(request.headers.get("content-type") ?? "").includes("application/json")) {
    return error("נדרש application/json", 415);
  }

  if (path === "/login" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { username?: unknown; password?: unknown };
    const userId = await login(env, body.username, body.password);
    if (userId === null) {
      await new Promise((r) => setTimeout(r, 600));
      return error("שם משתמש או סיסמה שגויים", 401);
    }
    return json({ ok: true }, 200, { "set-cookie": await createSessionCookie(env, cookiePath, userId) });
  }
  if (path === "/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(cookiePath) });
  }

  const principal = await getPrincipal(env, request);
  if (!principal) return error("נדרשת התחברות", 401);

  try {
    if (path === "/meta" && method === "GET") return json(await meta(env, principal));
    if (path === "/platform") return principal.role === "admin" ? await platformApi(request, env) : forbidden();
    if (path === "/tenants" || path.startsWith("/tenants/")) return principal.role === "admin" ? await tenantsApi(request, env, path) : forbidden();

    const m = path.match(/^\/([a-z0-9-]+)\/([a-z_]+)(?:\/(\d+|[a-z_]+))?\/?$/);
    if (!m) return error("לא נמצא", 404);
    const tenant = await getTenant(env.DB, m[1]!);
    if (!tenant) return error("לקוח לא קיים", 404);
    if (principal.role === "user" && principal.tenant.id !== tenant.id) return forbidden();
    const db = new TenantDb(env.DB, tenant);
    const action = m[2]!;
    const sub = m[3];

    if (action === "stats" && method === "GET" && !sub) return can(principal, "dashboard", "view") ? json(await stats(db)) : forbidden();
    if (action === "email") return await emailApi(request, principal, db, sub);
    if (action === "texts" && !sub) return await textsApi(request, principal, db);
    if (action === "info" && method === "GET") return can(principal, "settings", "view") ? json(tenantInfo(tenant)) : forbidden();

    const entity = getEntity(action);
    if (!entity) return error("לא נמצא", 404);
    const id = sub && /^\d+$/.test(sub) ? Number(sub) : null;
    if (sub && id === null) return error("לא נמצא", 404);
    const section = entity.name as Section;
    if (!can(principal, section, isMutation ? "edit" : "view")) return forbidden();

    if (method === "GET" && id === null) return json(await list(db, entity, new URL(request.url).searchParams));
    if (method === "GET" && id !== null) return await getOne(db, entity, id);
    if (entity.readOnly) return error("לקריאה בלבד", 405);
    if (method === "POST" && id === null) {
      if (entity.noCreate) return error("לא ניתן ליצור ידנית", 405);
      return await create(db, entity, await request.json());
    }
    if (method === "PUT" && id !== null) return await update(db, entity, id, await request.json());
    if (method === "DELETE" && id !== null) {
      if (!entity.deletable) return error("לא ניתן למחוק", 405);
      return await remove(db, entity, id);
    }
    return error("פעולה לא נתמכת", 405);
  } catch (err) {
    return dbError(err);
  }
}

function dbError(err: unknown): Response {
  const msg = String(err);
  if (msg.includes("UNIQUE")) return error("ערך כזה כבר קיים (למשל טלפון, קוד שלוחה או שם משתמש כפולים)", 409);
  if (msg.includes("FOREIGN KEY")) return error("לא ניתן למחוק - יש רשומות מקושרות (מנויים, הזמנות או תשלומים)", 409);
  if (msg.includes("CHECK")) return error("ערך לא חוקי", 400);
  console.error("admin api error", err);
  return error("שגיאת שרת", 500);
}

/** מה שמשתמש באזור האישי צריך כדי להגדיר שלוחות (מספר לקוח, מפתח) */
function tenantInfo(t: TenantConfig) {
  return {
    slug: t.slug,
    title: t.title,
    client_number: t.client_number,
    api_key: t.api_key,
    nedarim_mosad_id: t.nedarim_mosad_id,
  };
}

/** פרטי לקוח לרשימת הלקוחות של מנהל המערכת (בלי הגדרות המייל הגולמיות) */
function tenantRow(t: TenantConfig) {
  const { email_settings, ivr_texts, ...rest } = t;
  return { ...rest, email_ready: !!parseEmailSettings(email_settings).from_email };
}

async function meta(env: Env, p: Principal) {
  const entities = Object.fromEntries(
    Object.entries(ENTITIES).map(([name, e]) => {
      const ent = e as Entity;
      return [
        name,
        { label: ent.label, fields: ent.fields, columns: ent.columns, filters: ent.filters, readOnly: !!ent.readOnly, noCreate: !!ent.noCreate, deletable: !!ent.deletable },
      ];
    }),
  );
  const tenants = p.role === "admin" ? (await listTenants(env.DB)).map(tenantRow) : [tenantRow(p.tenant)];
  const permissions = Object.fromEntries(
    SECTIONS.map(({ key }) => [key, can(p, key, "edit") ? "edit" : can(p, key, "view") ? "view" : "none"]),
  );
  return {
    me: { role: p.role, name: p.name, username: p.role === "user" ? p.user.username : null },
    permissions,
    sections: SECTIONS,
    tenants,
    entities,
    email: { placeholders: PLACEHOLDERS },
  };
}

/** הגדרות מערכת (רק למנהל): מפתח Resend. המפתח לא חוזר במלואו. */
async function platformApi(request: Request, env: Env): Promise<Response> {
  const current = async () => ({
    resend_api_key: maskSecret(await getSetting(env.DB, "resend_api_key")),
    email_footer: (await getSetting(env.DB, "email_footer")) ?? "",
    default_email_footer: DEFAULT_EMAIL_FOOTER,
  });
  if (request.method === "GET") return json(await current());
  if (request.method !== "PUT") return error("פעולה לא נתמכת", 405);
  const body = (await request.json().catch(() => ({}))) as { resend_api_key?: unknown; email_footer?: unknown };
  if (typeof body.resend_api_key === "string") {
    const key = body.resend_api_key.trim();
    if (key && !/^re_[A-Za-z0-9_]{8,}$/.test(key)) return error("מפתח Resend מתחיל ב-re_");
    await setSetting(env.DB, "resend_api_key", key || null);
  }
  if (typeof body.email_footer === "string") {
    // ריק = ברירת המחדל
    await setSetting(env.DB, "email_footer", body.email_footer.trim().slice(0, 200) || null);
  }
  return json({ ok: true, ...(await current()) });
}

/** קורס / מוצר שמייל הבדיקה או התצוגה המקדימה מתייחסים אליו, עם פרטי רכישה לדוגמה */
async function sampleFor(db: TenantDb, input: { entity?: unknown; id?: unknown }): Promise<{ item: ItemSettings; purchase: PurchaseVars }> {
  const id = Number(input.id);
  if ((input.entity === "courses" || input.entity === "products") && Number.isInteger(id) && id > 0) {
    const row = await db.db.prepare(`SELECT * FROM ${db.t[input.entity]} WHERE id = ?`).bind(id).first<ItemSettings & { name: string; price: number; access_days?: number | null }>();
    if (row) {
      const isCourse = input.entity === "courses";
      return {
        item: row,
        purchase: {
          ...SAMPLE_PURCHASE,
          kind: isCourse ? "course" : "product",
          item: row.name,
          price: row.price > 0 ? `${row.price} ₪` : "ללא תשלום",
          phones: isCourse ? SAMPLE_PURCHASE.phones : "0527654321",
          validity: isCourse ? (row.access_days ? `${row.access_days} ימים` : "לצמיתות") : undefined,
        },
      };
    }
  }
  return { item: {}, purchase: SAMPLE_PURCHASE };
}

/** הגדרות מייל של לקוח, תצוגה מקדימה ושליחת מייל בדיקה */
async function emailApi(request: Request, p: Principal, db: TenantDb, sub: string | undefined): Promise<Response> {
  const method = request.method;
  if (!sub && method === "GET") {
    if (!can(p, "settings", "view")) return forbidden();
    return json({ settings: parseEmailSettings(db.tenant.email_settings), resend_ready: !!(await getSetting(db.db, "resend_api_key")) });
  }
  if (sub === "preview" && method === "POST") {
    if (!can(p, "settings", "view") && !can(p, "courses", "view") && !can(p, "products", "view")) return forbidden();
    const body = (await request.json().catch(() => ({}))) as { settings?: unknown; entity?: unknown; id?: unknown; item?: ItemSettings };
    const settings = body.settings ? validateEmailSettings(body.settings) : { settings: parseEmailSettings(db.tenant.email_settings) };
    if ("error" in settings) return error(settings.error);
    const { item, purchase } = await sampleFor(db, body);
    const override = body.item && typeof body.item === "object" ? { email_subject: body.item.email_subject, email_body: body.item.email_body } : {};
    return json(buildEmail(db.tenant.title, settings.settings, { ...item, ...override }, purchase, { footer: await emailFooter(db.db) }));
  }
  if (!can(p, "settings", "edit")) return forbidden();
  if (!sub && method === "PUT") {
    const v = validateEmailSettings(await request.json().catch(() => null));
    if ("error" in v) return error(v.error);
    await updateTenant(db.db, db.tenant.slug, { email_settings: JSON.stringify(v.settings) });
    return json({ ok: true, settings: v.settings });
  }
  if (sub === "test" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { to?: string; entity?: unknown; id?: unknown };
    const to = splitEmails(body.to ?? "");
    const bad = invalidEmail(body.to);
    if (bad) return error(`כתובת לא תקינה: ${bad}`);
    const { item, purchase } = await sampleFor(db, body);
    const result = await notify(db, item, purchase, { test: true, overrideTo: to.length ? to : undefined });
    return result.ok ? json({ ok: true, id: result.id }) : error(`המייל לא נשלח: ${result.error}`, 502);
  }
  return error("פעולה לא נתמכת", 405);
}

/** הטקסטים שהמתקשר שומע. נשמר רק מה ששונה מברירת המחדל. */
async function textsApi(request: Request, p: Principal, db: TenantDb): Promise<Response> {
  const list = () => {
    const saved = parseTexts(db.tenant.ivr_texts);
    return Object.entries(TEXTS).map(([key, def]) => ({ key, ...def, value: saved[key as keyof typeof saved] ?? "" }));
  };
  if (request.method === "GET") return can(p, "settings", "view") ? json({ texts: list() }) : forbidden();
  if (request.method !== "PUT") return error("פעולה לא נתמכת", 405);
  if (!can(p, "settings", "edit")) return forbidden();
  const body = (await request.json().catch(() => ({}))) as { texts?: Record<string, unknown> };
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(body.texts ?? {})) {
    if (!isTextKey(key) || typeof value !== "string") continue;
    const v = value.trim().slice(0, 500);
    if (v && v !== TEXTS[key].default) out[key] = v;
  }
  await updateTenant(db.db, db.tenant.slug, { ivr_texts: Object.keys(out).length ? JSON.stringify(out) : null });
  db.tenant.ivr_texts = Object.keys(out).length ? JSON.stringify(out) : null;
  return json({ ok: true, texts: list() });
}

/** ניהול הלקוחות של הפלטפורמה (רק למנהל): יצירה, עריכה, מפתח, ומשתמשי האזור האישי שלהם. */
async function tenantsApi(request: Request, env: Env, path: string): Promise<Response> {
  const method = request.method;
  const m = path.match(/^\/tenants(?:\/([a-z0-9-]+))?(?:\/(key|users)(?:\/(\d+))?)?\/?$/);
  if (!m) return error("לא נמצא", 404);
  const slug = m[1];
  const sub = m[2];

  if (!slug && method === "GET") return json({ rows: (await listTenants(env.DB)).map(tenantRow) });

  const body = method === "GET" ? {} : ((await request.json().catch(() => ({}))) as Record<string, unknown>);
  const str = (k: string, max = 200) => {
    const v = body[k];
    return v === undefined ? undefined : v === null || String(v).trim() === "" ? null : String(v).trim().slice(0, max);
  };
  const mosad = str("nedarim_mosad_id", 20);
  if (mosad && !/^\d+$/.test(mosad)) return error("מספר מוסד צריך להכיל ספרות בלבד");
  const clientRaw = str("client_number", 9);
  if (clientRaw && !/^[1-9]\d{0,8}$/.test(clientRaw)) return error("מספר לקוח צריך להיות מספר חיובי");
  const clientNumber: number | null | undefined = clientRaw ? Number(clientRaw) : (clientRaw as null | undefined);
  const contactPhone = str("contact_phone", 20);
  if (contactPhone && !normalizePhone(contactPhone)) return error("טלפון איש הקשר אינו תקין");

  if (!slug && method === "POST") {
    const title = str("title");
    const newSlug = str("slug", 40)?.toLowerCase();
    if (!title) return error("חסר שם לקוח");
    if (!newSlug || !SLUG_RE.test(newSlug) || newSlug === "tenants") {
      return error("מזהה לא תקין: אותיות באנגלית קטנות, ספרות ומקפים, ומתחיל באות (למשל cohen-store)");
    }
    try {
      const tenant = await createTenant(env.DB, {
        slug: newSlug,
        title,
        client_number: clientNumber ?? null,
        nedarim_mosad_id: mosad ?? null,
        contact_name: str("contact_name") ?? null,
        contact_phone: contactPhone ? normalizePhone(contactPhone) : null,
        notes: str("notes", 2000) ?? null,
      });
      return json({ ok: true, tenant: tenantRow(tenant) }, 201);
    } catch (err) {
      if (String(err).includes("SLUG_EXISTS")) return error("כבר קיים לקוח עם המזהה הזה", 409);
      if (String(err).includes("CLIENT_NUMBER_EXISTS")) return error("מספר הלקוח הזה כבר תפוס", 409);
      throw err;
    }
  }

  if (!slug) return error("פעולה לא נתמכת", 405);
  const tenant = await getTenant(env.DB, slug);
  if (!tenant) return error("לקוח לא קיים", 404);

  if (sub === "key" && method === "POST") return json({ ok: true, api_key: await rotateTenantKey(env.DB, slug) });
  if (sub === "users") return usersApi(method, env, tenant, m[3] ? Number(m[3]) : null, body);

  if (!sub && method === "PUT") {
    const values: Record<string, string | number | null> = {};
    for (const k of ["title", "contact_name", "notes"]) {
      const v = str(k, k === "notes" ? 2000 : 200);
      if (v !== undefined) values[k] = v;
    }
    if (values.title === null) return error("חסר שם לקוח");
    if (contactPhone !== undefined) values.contact_phone = contactPhone ? normalizePhone(contactPhone) : null;
    if (mosad !== undefined) values.nedarim_mosad_id = mosad;
    if (clientNumber !== undefined) {
      if (clientNumber === null) return error("חסר מספר לקוח");
      const taken = await env.DB.prepare("SELECT 1 FROM tenants WHERE client_number = ? AND id != ?").bind(clientNumber, tenant.id).first();
      if (taken) return error("מספר הלקוח הזה כבר תפוס", 409);
      values.client_number = clientNumber;
    }
    if ("is_active" in body) values.is_active = body.is_active === true || body.is_active === 1 || body.is_active === "1" ? 1 : 0;
    await updateTenant(env.DB, slug, values);
    return json({ ok: true, tenant: tenantRow((await getTenant(env.DB, slug))!) });
  }
  return error("פעולה לא נתמכת", 405);
}

const USERNAME_RE = /^[a-z0-9][a-z0-9._-]{2,39}$/;

/** משתמשי האזור האישי של לקוח, וההרשאות שלהם */
async function usersApi(method: string, env: Env, tenant: TenantConfig, id: number | null, body: Record<string, unknown>): Promise<Response> {
  const db = env.DB;
  const cleanPermissions = (raw: unknown) => JSON.stringify(parsePermissions(JSON.stringify(raw ?? {})));

  if (method === "GET" && id === null) {
    const rows = await db
      .prepare("SELECT id, username, display_name, permissions, is_active, last_login_at, created_at FROM portal_users WHERE tenant_id = ? ORDER BY id")
      .bind(tenant.id)
      .all();
    return json({ rows: rows.results.map((r) => ({ ...r, permissions: parsePermissions(r.permissions as string) })) });
  }

  const password = typeof body.password === "string" ? body.password : "";
  if (password && password.length < 8) return error("סיסמה צריכה להיות באורך 8 תווים לפחות");
  const displayName = typeof body.display_name === "string" ? body.display_name.trim().slice(0, 100) : undefined;

  if (method === "POST" && id === null) {
    const username = typeof body.username === "string" ? body.username.trim().toLowerCase() : "";
    if (!USERNAME_RE.test(username)) return error("שם משתמש: 3-40 תווים, אותיות באנגלית, ספרות, נקודה, מקף או קו תחתון");
    if (!password) return error("חסרה סיסמה");
    const { hash, salt } = await hashPassword(password);
    const row = await db
      .prepare(
        `INSERT INTO portal_users (tenant_id, username, display_name, password_hash, password_salt, permissions, is_active)
         VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING id`,
      )
      .bind(tenant.id, username, displayName || null, hash, salt, cleanPermissions(body.permissions), body.is_active === false ? 0 : 1)
      .first<{ id: number }>();
    return json({ ok: true, id: row!.id }, 201);
  }

  if (id === null) return error("פעולה לא נתמכת", 405);
  const exists = await db.prepare("SELECT 1 FROM portal_users WHERE id = ? AND tenant_id = ?").bind(id, tenant.id).first();
  if (!exists) return error("משתמש לא נמצא", 404);

  if (method === "DELETE") {
    await db.prepare("DELETE FROM portal_users WHERE id = ?").bind(id).run();
    return json({ ok: true });
  }
  if (method === "PUT") {
    const sets: string[] = [];
    const binds: unknown[] = [];
    if (displayName !== undefined) sets.push("display_name = ?"), binds.push(displayName || null);
    if ("permissions" in body) sets.push("permissions = ?"), binds.push(cleanPermissions(body.permissions));
    if ("is_active" in body) sets.push("is_active = ?"), binds.push(body.is_active === true || body.is_active === 1 ? 1 : 0);
    if (password) {
      const { hash, salt } = await hashPassword(password);
      sets.push("password_hash = ?", "password_salt = ?");
      binds.push(hash, salt);
    }
    if (sets.length) await db.prepare(`UPDATE portal_users SET ${sets.join(", ")} WHERE id = ?`).bind(...binds, id).run();
    return json({ ok: true });
  }
  return error("פעולה לא נתמכת", 405);
}

async function list(db: TenantDb, entity: Entity & { name: EntityName }, params: URLSearchParams) {
  const where: string[] = [];
  const binds: unknown[] = [];

  for (const f of entity.filters) {
    const v = params.get(f);
    if (v !== null && v !== "") {
      where.push(`x.${f} = ?`);
      binds.push(v);
    }
  }
  const q = params.get("q")?.trim();
  if (q) {
    const conds = entity.search(db.t);
    where.push(`(${conds.join(" OR ")})`);
    for (let i = 0; i < conds.length; i++) binds.push(`%${q}%`);
  }

  const limit = Math.min(Math.max(Number(params.get("limit")) || 50, 1), 500);
  const offset = Math.max(Number(params.get("offset")) || 0, 0);
  const whereSql = where.length ? ` WHERE ${where.join(" AND ")}` : "";
  const base = `${entity.select(db.t)}${whereSql}`;

  const [rows, count] = await db.db.batch([
    db.db.prepare(`${base} ORDER BY x.id DESC LIMIT ? OFFSET ?`).bind(...binds, limit, offset),
    db.db.prepare(`SELECT count(*) AS n FROM (${base})`).bind(...binds),
  ]);
  return { rows: rows!.results, total: (count!.results[0] as { n: number }).n, limit, offset };
}

async function getOne(db: TenantDb, entity: Entity & { name: EntityName }, id: number): Promise<Response> {
  const row = await db.db.prepare(`${entity.select(db.t)} WHERE x.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) return error("לא נמצא", 404);

  if (entity.name === "subscriptions") {
    const phones = await db.db
      .prepare(`SELECT phone FROM ${db.t.subscription_phones} WHERE subscription_id = ? ORDER BY slot`)
      .bind(id)
      .all<{ phone: string }>();
    return json({ row: { ...row, phone_list: phones.results.map((p) => p.phone) } });
  }

  if (entity.name === "customers") {
    const by = (name: EntityName) => {
      const e = ENTITIES[name] as Entity;
      return db.db.prepare(`${e.select(db.t)} WHERE x.customer_id = ? ORDER BY x.id DESC LIMIT 200`).bind(id);
    };
    const [subs, orders, payments, log] = await db.db.batch([
      by("subscriptions"),
      by("orders"),
      by("payments"),
      db.db.prepare(`SELECT * FROM ${db.t.ivr_log} WHERE phone = ? ORDER BY id DESC LIMIT 50`).bind(row.main_phone),
    ]);
    return json({ row, related: { subscriptions: subs!.results, orders: orders!.results, payments: payments!.results, ivr_log: log!.results } });
  }

  return json({ row });
}

type Values = Record<string, string | number | null>;

function validate(fields: Field[], body: unknown, partial: boolean): { values: Values } | { error: string } {
  if (!body || typeof body !== "object") return { error: "גוף בקשה לא תקין" };
  const input = body as Record<string, unknown>;
  const values: Values = {};

  for (const f of fields) {
    if (!(f.name in input)) {
      if (!partial && f.default !== undefined) values[f.name] = f.default;
      else if (!partial && f.required) return { error: `חסר שדה: ${f.label}` };
      continue;
    }
    const raw = input[f.name];
    const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
      if (f.default !== undefined) {
        values[f.name] = f.default;
        continue;
      }
      if (f.required) return { error: `חסר שדה: ${f.label}` };
      values[f.name] = null;
      continue;
    }
    const str = String(raw).trim();
    let v: string | number | null;
    switch (f.type) {
      case "text":
        v = str.slice(0, 200);
        break;
      case "longtext":
        v = str.slice(0, 5000);
        break;
      case "phone":
        v = normalizePhone(str);
        if (!v) return { error: `טלפון לא תקין: ${f.label}` };
        break;
      case "emails": {
        const bad = invalidEmail(str);
        if (bad) return { error: `כתובת מייל לא תקינה: ${bad}` };
        v = splitEmails(str).join(", ").slice(0, 1000);
        break;
      }
      case "int":
      case "ref":
        v = Number(str);
        if (!Number.isInteger(v) || v < 0) return { error: `מספר שלם לא תקין: ${f.label}` };
        break;
      case "real":
        v = Number(str);
        if (!Number.isFinite(v) || v < 0) return { error: `מספר לא תקין: ${f.label}` };
        v = Math.round(v * 100) / 100;
        break;
      case "bool":
        v = raw === true || str === "1" || str === "true" ? 1 : 0;
        break;
      case "enum":
        if (!f.options?.some((o) => o.value === str)) return { error: `ערך לא חוקי: ${f.label}` };
        v = str;
        break;
      case "date":
        if (!/^\d{4}-\d{2}-\d{2}$/.test(str)) return { error: `תאריך לא תקין: ${f.label}` };
        v = str;
        break;
      case "datetime":
        if (!/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(str)) return { error: `מועד לא תקין: ${f.label}` };
        v = str.replace("T", " ");
        break;
    }
    values[f.name] = v;
  }
  return { values };
}

function parsePhones(raw: unknown): { phones: string[] } | { error: string } | null {
  if (raw === undefined) return null;
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(/[,\s]+/) : [];
  const phones: string[] = [];
  for (const item of list) {
    if (item === null || String(item).trim() === "") continue;
    const p = normalizePhone(String(item));
    if (!p) return { error: `טלפון לא תקין: ${item}` };
    if (!phones.includes(p)) phones.push(p);
  }
  return { phones };
}

async function checkPhoneLimit(db: TenantDb, courseId: unknown, phones: string[]): Promise<string | null> {
  const course = typeof courseId === "number" ? await db.getCourse(courseId) : null;
  const max = Math.max(1, course?.max_phones ?? 1);
  return phones.length > max ? `לקורס הזה אפשר עד ${max} טלפונים` : null;
}

/**
 * מחיקה. תשלומים לא נמחקים עם מנוי/הזמנה - רק מנותקים מהם, כדי לשמור את היסטוריית התשלומים.
 * מחיקת רוכש מוחקת את כל הנתונים שלו. קורס/מוצר שיש לו רכישות לא נמחק (אפשר לסמן כלא פעיל).
 */
async function remove(db: TenantDb, entity: Entity & { name: EntityName }, id: number): Promise<Response> {
  const t = db.t;
  const q = (sql: string, ...binds: unknown[]) => db.db.prepare(sql).bind(...binds);
  const exists = await q(`SELECT 1 FROM ${t[entity.table]} WHERE id = ?`, id).first();
  if (!exists) return error("לא נמצא", 404);

  switch (entity.name) {
    case "subscriptions":
      await db.db.batch([
        q(`UPDATE ${t.payments} SET subscription_id = NULL WHERE subscription_id = ?`, id),
        q(`DELETE FROM ${t.subscription_phones} WHERE subscription_id = ?`, id),
        q(`DELETE FROM ${t.subscriptions} WHERE id = ?`, id),
      ]);
      break;
    case "orders":
      await db.db.batch([q(`UPDATE ${t.payments} SET order_id = NULL WHERE order_id = ?`, id), q(`DELETE FROM ${t.orders} WHERE id = ?`, id)]);
      break;
    case "customers":
      await db.db.batch([
        q(`DELETE FROM ${t.payments} WHERE customer_id = ?`, id),
        q(`DELETE FROM ${t.subscription_phones} WHERE subscription_id IN (SELECT id FROM ${t.subscriptions} WHERE customer_id = ?)`, id),
        q(`DELETE FROM ${t.subscriptions} WHERE customer_id = ?`, id),
        q(`DELETE FROM ${t.orders} WHERE customer_id = ?`, id),
        q(`DELETE FROM ${t.customers} WHERE id = ?`, id),
      ]);
      break;
    case "courses": {
      const used = await q(`SELECT count(*) AS n FROM ${t.subscriptions} WHERE course_id = ?`, id).first<{ n: number }>();
      if (used!.n > 0) return error(`לקורס יש ${used!.n} מנויים, לכן אי אפשר למחוק אותו. אפשר לבטל את הסימון "פעיל", או למחוק קודם את המנויים.`, 409);
      await q(`DELETE FROM ${t.courses} WHERE id = ?`, id).run();
      break;
    }
    case "products": {
      const used = await q(`SELECT count(*) AS n FROM ${t.orders} WHERE product_id = ?`, id).first<{ n: number }>();
      if (used!.n > 0) return error(`למוצר יש ${used!.n} הזמנות, לכן אי אפשר למחוק אותו. אפשר לבטל את הסימון "פעיל".`, 409);
      await q(`DELETE FROM ${t.products} WHERE id = ?`, id).run();
      break;
    }
    case "payments":
      await q(`DELETE FROM ${t.payments} WHERE id = ?`, id).run();
      break;
    default:
      return error("לא ניתן למחוק", 405);
  }
  return json({ ok: true });
}

function replacePhones(db: TenantDb, subscriptionId: number, phones: string[]): D1PreparedStatement[] {
  return [
    db.db.prepare(`DELETE FROM ${db.t.subscription_phones} WHERE subscription_id = ?`).bind(subscriptionId),
    ...phones.map((phone, i) =>
      db.db.prepare(`INSERT INTO ${db.t.subscription_phones} (subscription_id, phone, slot) VALUES (?, ?, ?)`).bind(subscriptionId, phone, i + 1),
    ),
  ];
}

/** מנוי שנוצר ידנית כפעיל בלי תאריכים מקבל תאריך התחלה היום ותוקף לפי הקורס. */
async function fillSubscriptionDates(db: TenantDb, values: Values): Promise<void> {
  if (values.status !== "active") return;
  if (!values.start_date) values.start_date = todayIso();
  if (!values.end_date && typeof values.course_id === "number") {
    const course = await db.getCourse(values.course_id);
    if (course?.access_days) values.end_date = addDays(String(values.start_date), course.access_days);
  }
}

async function create(db: TenantDb, entity: Entity & { name: EntityName }, body: unknown): Promise<Response> {
  const v = validate(entity.fields, body, false);
  if ("error" in v) return error(v.error);
  const input = body as Record<string, unknown>;

  let phones: string[] = [];
  if (entity.name === "subscriptions") {
    const p = parsePhones(input.phones);
    if (p && "error" in p) return error(p.error);
    phones = p?.phones ?? [];
    if (phones.length === 0) return error("יש להזין לפחות טלפון אחד עם גישה");
    const limit = await checkPhoneLimit(db, v.values.course_id, phones);
    if (limit) return error(limit);
    await fillSubscriptionDates(db, v.values);
  }

  const cols = Object.keys(v.values);
  const row = await db.db
    .prepare(`INSERT INTO ${db.t[entity.table]} (${cols.join(", ")}) VALUES (${cols.map(() => "?").join(", ")}) RETURNING id`)
    .bind(...cols.map((c) => v.values[c]))
    .first<{ id: number }>();

  if (entity.name === "subscriptions") {
    try {
      await db.db.batch(replacePhones(db, row!.id, phones));
    } catch (err) {
      await db.db.prepare(`DELETE FROM ${db.t.subscriptions} WHERE id = ?`).bind(row!.id).run();
      throw err;
    }
  }
  return json({ ok: true, id: row!.id }, 201);
}

async function update(db: TenantDb, entity: Entity & { name: EntityName }, id: number, body: unknown): Promise<Response> {
  const v = validate(entity.fields, body, true);
  if ("error" in v) return error(v.error);
  const input = body as Record<string, unknown>;

  const stmts: D1PreparedStatement[] = [];
  if (entity.name === "subscriptions") {
    const p = parsePhones(input.phones);
    if (p && "error" in p) return error(p.error);
    if (p) {
      if (p.phones.length === 0) return error("יש להזין לפחות טלפון אחד עם גישה");
      const courseId = v.values.course_id ?? (await db.getSubscription(id))?.course_id;
      const limit = await checkPhoneLimit(db, courseId, p.phones);
      if (limit) return error(limit);
      stmts.push(...replacePhones(db, id, p.phones));
    }
  }

  const cols = Object.keys(v.values);
  if (cols.length === 0 && stmts.length === 0) return error("אין מה לעדכן");
  if (cols.length) {
    const set = cols.map((c) => `${c} = ?`);
    if (entity.hasUpdatedAt) set.push("updated_at = datetime('now')");
    stmts.unshift(
      db.db.prepare(`UPDATE ${db.t[entity.table]} SET ${set.join(", ")} WHERE id = ?`).bind(...cols.map((c) => v.values[c]), id),
    );
  }

  const exists = await db.db.prepare(`SELECT 1 FROM ${db.t[entity.table]} WHERE id = ?`).bind(id).first();
  if (!exists) return error("לא נמצא", 404);
  await db.db.batch(stmts);
  return json({ ok: true });
}

async function stats(db: TenantDb) {
  const t = db.t;
  const one = (sql: string) => db.db.prepare(sql);
  const [counts, recent, daily, topCourses] = await db.db.batch([
    one(`SELECT
      (SELECT count(*) FROM ${t.customers}) AS customers,
      (SELECT count(*) FROM ${t.courses} WHERE is_active = 1) AS courses,
      (SELECT count(*) FROM ${t.subscriptions} WHERE status = 'active' AND (end_date IS NULL OR end_date > '${todayIso()}')) AS active_subscriptions,
      (SELECT count(*) FROM ${t.subscriptions} WHERE created_at >= datetime('now', '-30 days')) AS new_subscriptions_30d,
      (SELECT count(*) FROM ${t.orders} WHERE status IN ('paid','scheduled')) AS open_orders,
      (SELECT COALESCE(sum(amount), 0) FROM ${t.payments} WHERE status = 'success') AS revenue_total,
      (SELECT COALESCE(sum(amount), 0) FROM ${t.payments} WHERE status = 'success' AND created_at >= datetime('now', '-30 days')) AS revenue_30d,
      (SELECT count(*) FROM ${t.ivr_log} WHERE action = 'purchase_offer' AND created_at >= datetime('now', '-30 days')) AS offers_30d`),
    one(`${(ENTITIES.payments as Entity).select(t)} ORDER BY x.id DESC LIMIT 8`),
    one(`SELECT date(created_at) AS day, COALESCE(sum(amount), 0) AS amount, count(*) AS count FROM ${t.payments}
         WHERE status = 'success' AND created_at >= date('now', '-29 days') GROUP BY day ORDER BY day`),
    one(`SELECT c.name, count(s.id) AS subs FROM ${t.courses} c LEFT JOIN ${t.subscriptions} s ON s.course_id = c.id AND s.status = 'active'
         GROUP BY c.id ORDER BY subs DESC LIMIT 5`),
  ]);
  return { counts: counts!.results[0], recentPayments: recent!.results, daily: daily!.results, topCourses: topCourses!.results };
}
