import adminHtml from "./admin/admin.html";
import { handleAdminApi } from "./admin/api";
import { TenantDb } from "./db/repo";
import type { Env } from "./env";
import { handleCourse } from "./ivr/course";
import { failResponse, type IvrContext } from "./ivr/common";
import { handleProduct } from "./ivr/product";
import { isAuthorized } from "./lib/auth";
import { getAdapter } from "./payments";
import { applyPaymentEvent } from "./payments/process";
import { readFlatPayload } from "./payments/provider";
import { resolveTenant } from "./tenants";
import { parseYemotRequest } from "./yemot/request";

/**
 * תחיליות נתיב שה-Worker יכול להיות מחובר תחתן (למשל route של smti.uk/yemot-pay*).
 * הבקשה מגיעה עם הנתיב המלא, ולכן מסירים את התחילית לפני הניתוב.
 */
const BASE_PATHS = ["/yemot-pay"];

const IVR_HANDLERS: Record<string, (ctx: IvrContext) => Promise<Response>> = {
  course: handleCourse,
  product: handleProduct,
};

const ROUTE = /^\/(ivr|pay)\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });

function splitBase(pathname: string): { base: string; path: string } {
  for (const base of BASE_PATHS) {
    if (pathname === base || pathname.startsWith(`${base}/`)) return { base, path: pathname.slice(base.length) || "/" };
  }
  return { base: "", path: pathname };
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { base, path } = splitBase(new URL(request.url).pathname);
  if (request.method !== "GET" && request.method !== "POST" && request.method !== "PUT" && request.method !== "DELETE") {
    return json({ error: "method_not_allowed" }, 405);
  }

  if (path === "/health") return json({ ok: true });
  if (path === "/" || path === "/admin") return Response.redirect(new URL(`${base}/admin/`, request.url).toString(), 302);
  if (path === "/admin/") {
    return new Response(adminHtml, {
      headers: {
        "content-type": "text/html; charset=utf-8",
        "cache-control": "no-store",
        "x-frame-options": "DENY",
        "referrer-policy": "no-referrer",
        "x-content-type-options": "nosniff",
      },
    });
  }
  if (path.startsWith("/admin/api/")) return handleAdminApi(request, env, path.slice("/admin/api".length), `${base}/admin`);

  if (request.method !== "GET" && request.method !== "POST") return json({ error: "method_not_allowed" }, 405);
  const match = ROUTE.exec(path);
  if (!match) return json({ error: "not_found" }, 404);
  const [, area, tenantSlug, action] = match as unknown as [string, "ivr" | "pay", string, string];

  const tenant = resolveTenant(tenantSlug);
  if (!tenant) return json({ error: "not_found" }, 404);

  return area === "ivr" ? handleIvr(request, env, tenant.slug, action) : handlePay(request, env, tenant.slug, action);
}

async function handleIvr(request: Request, env: Env, tenantSlug: string, action: string): Promise<Response> {
  const handler = Object.hasOwn(IVR_HANDLERS, action) ? IVR_HANDLERS[action]! : null;
  if (!handler) return json({ error: "not_found" }, 404);

  const req = await parseYemotRequest(request);
  if (!(await isAuthorized(env, tenantSlug, req.get("key")))) return json({ error: "forbidden" }, 403);

  const db = new TenantDb(env.DB, resolveTenant(tenantSlug)!);
  if (req.hangup) {
    await db.log(req.phone, req.callId, "hangup", { endpoint: action });
    return new Response("");
  }

  try {
    return await handler({ db, req });
  } catch (err) {
    console.error("ivr handler error", err);
    await db.log(req.phone, req.callId, "error", { endpoint: action, message: String(err) }).catch(() => {});
    return failResponse(req);
  }
}

async function handlePay(request: Request, env: Env, tenantSlug: string, providerName: string): Promise<Response> {
  const adapter = getAdapter(providerName);
  if (!adapter) return json({ error: "not_found" }, 404);
  if (!(await isAuthorized(env, tenantSlug, new URL(request.url).searchParams.get("key")))) return json({ error: "forbidden" }, 403);

  const db = new TenantDb(env.DB, resolveTenant(tenantSlug)!);
  const copy = request.clone();
  const event = await adapter.parse(request);
  if (!event) {
    // נרשם עם הנתונים הגולמיים (ממוסכים) כדי שאפשר יהיה לתקן את מיפוי השדות
    await db.log(adapter.name, null, "payment_callback_invalid", { raw: await readFlatPayload(copy) });
    return json({ ok: false, error: "invalid_payload" }, 400);
  }
  const outcome = await applyPaymentEvent(db, adapter.name, event);
  return json({ ok: true, outcome });
}
