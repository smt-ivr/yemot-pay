import type { Env } from "../env";

const COOKIE = "yp_admin";
const TTL_SECONDS = 12 * 60 * 60;
const enc = new TextEncoder();

async function sha256(text: string): Promise<ArrayBuffer> {
  return crypto.subtle.digest("SHA-256", enc.encode(text));
}

/** מפתח החתימה נגזר מהסיסמה, כך שהחלפת סיסמה מנתקת את כל החיבורים. */
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

export async function checkPassword(env: Env, password: unknown): Promise<boolean> {
  if (!adminConfigured(env) || typeof password !== "string") return false;
  const [a, b] = await Promise.all([sha256(password), sha256(env.ADMIN_PASSWORD)]);
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function createSessionCookie(env: Env, cookiePath: string): Promise<string> {
  const exp = Math.floor(Date.now() / 1000) + TTL_SECONDS;
  const sig = await crypto.subtle.sign("HMAC", await signingKey(env), enc.encode(`admin:${exp}`));
  return `${COOKIE}=${exp}.${b64url(sig)}; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=${TTL_SECONDS}`;
}

export function clearSessionCookie(cookiePath: string): string {
  return `${COOKIE}=; Path=${cookiePath}; HttpOnly; Secure; SameSite=Strict; Max-Age=0`;
}

export async function hasValidSession(env: Env, request: Request): Promise<boolean> {
  if (!adminConfigured(env)) return false;
  const cookie = request.headers.get("cookie") ?? "";
  const match = cookie.match(new RegExp(`(?:^|;\\s*)${COOKIE}=(\\d+)\\.([A-Za-z0-9_-]+)`));
  if (!match) return false;
  const exp = Number(match[1]);
  if (!(exp > Date.now() / 1000)) return false;
  const sig = fromB64url(match[2]!);
  if (!sig) return false;
  return crypto.subtle.verify("HMAC", await signingKey(env), sig, enc.encode(`admin:${exp}`));
}
