import type { Env } from "../env";

/** בודק את המפתח שנשלח מול המפתח של הלקוח שב-TENANT_KEYS, בהשוואה בזמן קבוע. */
export async function isAuthorized(env: Env, tenantSlug: string, provided: string | null): Promise<boolean> {
  if (!provided) return false;
  let keys: Record<string, unknown>;
  try {
    keys = JSON.parse(env.TENANT_KEYS ?? "{}");
  } catch {
    return false;
  }
  const expected = keys[tenantSlug];
  if (typeof expected !== "string" || expected.length < 16) return false;

  const enc = new TextEncoder();
  const [a, b] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(provided)),
    crypto.subtle.digest("SHA-256", enc.encode(expected)),
  ]);
  return crypto.subtle.timingSafeEqual(a, b);
}
