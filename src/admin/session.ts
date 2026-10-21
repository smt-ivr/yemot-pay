import type { Env } from "../env";
import { getTenantById, type TenantConfig } from "../tenants";

const COOKIE = "yp_admin";
const TTL_SECONDS = 12 * 60 * 60;
const enc = new TextEncoder();

/** אזורי הרשאה של משתמש באזור האישי, וההרשאה בכל אזור */
export const SECTIONS = [
  { key: "dashboard", label: "לוח בקרה" },
  { key: "courses", label: "קורסים" },
  { key: "subscriptions", label: "מנויים" },
  { key: "customers", label: "רוכשים" },
  { key: "products", label: "מוצרים ופגישות" },
  { key: "orders", label: "הזמנות" },
  { key: "payments", label: "תשלומים" },
  { key: "ivr_log", label: "יומן שיחות" },
  { key: "settings", label: "הגדרות (מיילים ושלוחות)" },
] as const;
export type Section = (typeof SECTIONS)[number]["key"];
export type Level = "none" | "view" | "edit";
export type Permissions = Partial<Record<Section, Level>>;

export interface PortalUser {
  id: number;
  tenant_id: number;
  username: string;
  display_name: string | null;
  permissions: string;
  is_active: number;
  last_login_at: string | null;
  created_at: string;
}

export type Principal =
  | { role: "admin"; name: string }
  | { role: "user"; name: string; user: PortalUser; tenant: TenantConfig; permissions: Permissions };

export function parsePermissions(raw: string | null | undefined): Permissions {
  try {
    const obj = JSON.parse(raw ?? "{}") as Record<string, unknown>;
    const out: Permissions = {};
    for (const { key } of SECTIONS) {
      const v = obj[key];
      if (v === "view" || v === "edit" || v === "none") out[key] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/** האם למשתמש יש לפחות הרשאת level באזור section. מנהל המערכת תמיד מורשה. */
export function can(p: Principal, section: Section, level: "view" | "edit"): boolean {
  if (p.role === "admin") return true;
  const have = p.permissions[section] ?? "none";
  return level === "view" ? have === "view" || have === "edit" : have === "edit";
}

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(text));
}

function hex(buf: ArrayBuffer | Uint8Array): string {
  return Array.from(buf instanceof Uint8Array ? buf : new Uint8Array(buf), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** סיסמאות משתמשים: PBKDF2-SHA256, 100,000 סבבים, salt אקראי */
export async function hashPassword(password: string, saltHex?: string): Promise<{ hash: string; salt: string }> {
  const salt = saltHex ?? hex(crypto.getRandomValues(new Uint8Array(16)));
  const key = await crypto.subtle.importKey("raw", enc.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt: enc.encode(salt), iterations: 100_000 }, key, 256);
  return { hash: hex(bits), salt };
}

async function equalConstantTime(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)]);
  return crypto.subtle.timingSafeEqual(x, y);
}

/** מפתח החתימה נגזר מסיסמת המנהל, כך שהחלפתה מנתקת את כל החיבורים. */
async function signingKey(env: Env): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", await sha256(`yemot-pay-session:${env.ADMIN_PASSWORD}`), { name: "HMAC", hash: "SHA-256" }, false, [
    "sign",
    "verify",
  ]);
}

function b64url(buf: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(buf)))
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

function fromB64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/"));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

export function adminConfigured(env: Env): boolean {
  return typeof env.ADMIN_PASSWORD === "string" && env.ADMIN_PASSWORD.length >= 8;
}

/**
 * כניסה: בלי שם משתמש = מנהל המערכת (ADMIN_PASSWORD). עם שם משתמש = משתמש של לקוח.
 * מחזיר את מזהה המשתמש לעוגייה (0 = מנהל), או null.
 */
export async function login(env: Env, username: unknown, password: unknown): Promise<number | null> {
  if (!adminConfigured(env) || typeof password !== "string" || !password) return null;
  const name = typeof username === "string" ? username.trim().toLowerCase() : "";
  if (!name) return (await equalConstantTime(password, env.ADMIN_PASSWORD)) ? 0 : null;

  const user = await env.DB.prepare("SELECT id, password_hash, password_salt, is_active FROM portal_users WHERE username = ?")
    .bind(name)
    .first<{ id: number; password_hash: string; password_salt: string; is_active: number }>();
  // גם כשאין משתמש מחשבים hash, כדי שזמן התגובה לא יגלה אילו שמות קיימים
  const { hash } = await hashPassword(password, user?.password_salt ?? "0".repeat(32));
  if (!user || !user.is_active || !(await equalConstantTime(hash, user.password_hash))) return null;
  await env.DB.prepare("UPDATE portal_users SET last_login_at = datetime('now') WHERE id = ?").bind(user.id).run();
  return user.id;
}

export async function createSessionCookie(env: Env, cookiePath: string, userId: number): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(`session:${userId}:${exp}`));
  return `${COOKIE}=${userId}.${exp}.${b64url(sig)}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`;
}

export function clearSessionCookie(cookiePath: string): string {
  return `${COOKIE}=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

/** מי מחובר: מנהל המערכת, משתמש פעיל של לקוח פעיל, או null. */
export async function getPrincipal(env: Env, request: Request): Promise<Principal | null> {
  if (!adminConfigured(env)) return null;
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.(\\d+)\\.([A-Za-z0-9_-]+)`));
  if (!match) return null;
  const userId = Number(match[1]);
  const exp = Number(match[2]);
  if (!(exp > Date.now() / 1000)) return null;
  const sig = fromB64url(match[3]!);
  if (!sig || !(await crypto.subtle.verify("HMAC", await signingKey(env), sig, enc.encode(`session:${userId}:${exp}`)))) return null;

  if (userId === 0) return { role: "admin", name: "מנהל המערכת" };
  const user = await env.DB.prepare("SELECT * FROM portal_users WHERE id = ?").bind(userId).first<PortalUser & { password_hash?: string }>();
  if (!user || !user.is_active) return null;
  const tenant = await getTenantById(env.DB, user.tenant_id);
  if (!tenant || !tenant.is_active) return null;
  delete user.password_hash;
  return { role: "user", name: user.display_name || user.username, user, tenant, permissions: parsePermissions(user.permissions) };
}
