import { TenantDb } from "../db/repo";
import type { Env } from "../env";
import { addDays, normalizePhone, todayIso } from "../lib/util";
import { allTenants, resolveTenant } from "../tenants";
import { ENTITIES, getEntity, type Entity, type EntityName, type Field } from "./entities";
import { checkPassword, clearSessionCookie, createSessionCookie, hasValidSession } from "./session";

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { "cache-control": "no-store", ...headers } });
const error = (message: string, status = 400) => json({ error: message }, status);

/**
 * API של מערכת הניהול. path הוא הנתיב אחרי /admin/api.
 * cookiePath הוא נתיב מערכת הניהול (כולל תחילית כמו /yemot-pay) לעוגיית ההתחברות.
 */
export async function handleAdminApi(request: Request, env: Env, path: string, cookiePath: string): Promise<Response> {
  const method = request.method;
  const isMutation = method !== "GET";
  if (isMutation && !(request.headers.get("content-type") ?? "").includes("application/json")) {
    return error("נדרש application/json", 415);
  }

  if (path === "/login" && method === "POST") {
    const body = (await request.json().catch(() => ({}))) as { password?: unknown };
    if (!(await checkPassword(env, body.password))) {
      await new Promise((r) => setTimeout(r, 600));
      return error("סיסמה שגויה", 401);
    }
    return json({ ok: true }, 200, { "set-cookie": await createSessionCookie(env, cookiePath) });
  }
  if (path === "/logout" && method === "POST") {
    return json({ ok: true }, 200, { "set-cookie": clearSessionCookie(cookiePath) });
  }

  if (!(await hasValidSession(env, request))) return error("נדרשת התחברות", 401);

  if (path === "/meta" && method === "GET") return json(meta());

  const m = path.match(/^\/([a-z0-9-]+)\/([a-z_]+)(?:\/(\d+))?\/?$/);
  if (!m) return error("לא נמצא", 404);
  const tenant = resolveTenant(m[1]!);
  if (!tenant) return error("לקוח לא קיים", 404);
  const db = new TenantDb(env.DB, tenant);
  const id = m[3] ? Number(m[3]) : null;

  if (m[2] === "stats" && method === "GET" && id === null) return json(await stats(db));

  const entity = getEntity(m[2]!);
  if (!entity) return error("לא נמצא", 404);

  try {
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
      const res = await db.db.prepare(`DELETE FROM ${db.t[entity.table]} WHERE id = ?`).bind(id).run();
      return res.meta.changes ? json({ ok: true }) : error("לא נמצא", 404);
    }
    return error("פעולה לא נתמכת", 405);
  } catch (err) {
    return dbError(err);
  }
}

function dbError(err: unknown): Response {
  const msg = String(err);
  if (msg.includes("UNIQUE")) return error("ערך כזה כבר קיים (למשל טלפון או קוד שלוחה כפולים)", 409);
  if (msg.includes("FOREIGN KEY")) return error("לא ניתן למחוק - יש רשומות מקושרות (מנויים, הזמנות או תשלומים)", 409);
  if (msg.includes("CHECK")) return error("ערך לא חוקי", 400);
  if (msg.includes("no such column")) return error("חסרה עמודה במסד - יש להריץ את המיגרציות", 500);
  console.error("admin api error", err);
  return error("שגיאת שרת", 500);
}

function meta() {
  const entities = Object.fromEntries(
    Object.entries(ENTITIES).map(([name, e]) => {
      const ent = e as Entity;
      return [
        name,
        { label: ent.label, fields: ent.fields, columns: ent.columns, filters: ent.filters, readOnly: !!ent.readOnly, noCreate: !!ent.noCreate, deletable: !!ent.deletable },
      ];
    }),
  );
  return { tenants: allTenants().map((t) => ({ slug: t.slug, title: t.title })), entities };
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
      if (!partial && f.required) return { error: `חסר שדה: ${f.label}` };
      continue;
    }
    const raw = input[f.name];
    const empty = raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "");
    if (empty) {
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
  if (phones.length > 2) return { error: "אפשר עד 2 טלפונים למנוי" };
  return { phones };
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
  const [counts, recent] = await db.db.batch([
    one(`SELECT
      (SELECT count(*) FROM ${t.customers}) AS customers,
      (SELECT count(*) FROM ${t.courses} WHERE is_active = 1) AS courses,
      (SELECT count(*) FROM ${t.subscriptions} WHERE status = 'active' AND (end_date IS NULL OR end_date >= date('now'))) AS active_subscriptions,
      (SELECT count(*) FROM ${t.subscriptions} WHERE status = 'pending') AS pending_subscriptions,
      (SELECT count(*) FROM ${t.orders} WHERE status IN ('paid','scheduled')) AS open_orders,
      (SELECT COALESCE(sum(amount), 0) FROM ${t.payments} WHERE status = 'success') AS revenue_total,
      (SELECT COALESCE(sum(amount), 0) FROM ${t.payments} WHERE status = 'success' AND created_at >= datetime('now', '-30 days')) AS revenue_30d,
      (SELECT count(*) FROM ${t.payments} WHERE status = 'failed' AND created_at >= datetime('now', '-30 days')) AS failed_30d`),
    one(`${(ENTITIES.payments as Entity).select(t)} ORDER BY x.id DESC LIMIT 10`),
  ]);
  return { counts: counts!.results[0], recentPayments: recent!.results };
}
