import adminHtml from "./admin/admin.html";
import { handleAdminApi } from "./admin/api";
import { TenantDb } from "./db/repo";
import type { Env } from "./env";
import { handleCheck } from "./ivr/check";
import { failResponse, type IvrContext } from "./ivr/common";
import { handleCourse } from "./ivr/course";
import { handleProduct } from "./ivr/product";
import { ensurePlatform, getTenant, keyMatches } from "./tenants";
import { parseYemotRequest } from "./yemot/request";

/**
 * תחיליות נתיב שה-Worker יכול להיות מחובר תחתן (למשל route של smti.uk/yemot-pay*).
 * הבקשה מגיעה עם הנתיב המלא, ולכן מסירים את התחילית לפני הניתוב.
 */
const BASE_PATHS = ["/yemot-pay"];

/** שלוחות שמבצעות רכישה - דורשות את מפתח הלקוח (api_add_0=key=...), כי אליהן חוזר אישור הסליקה. */
const IVR_HANDLERS: Record<string, (ctx: IvrContext) => Promise<Response>> = {
  course: handleCourse,
  product: handleProduct,
};

const IVR_ROUTE = /^\/ivr\/([a-z0-9-]+)\/([a-z0-9-]+)\/?$/;

const json = (body: unknown, status = 200) => Response.json(body, { status });
const text = (body: string) => new Response(body, { headers: { "content-type": "text/plain; charset=utf-8" } });

function splitBase(pathname: string): { base: string; path: string } {
  for (const base of BASE_PATHS) {
    if (pathname === base || pathname.startsWith(`${base}/`)) return { base, path: pathname.slice(base.length) || "/" };
  }
  return { base: "", path: pathname };
}

export async function handleRequest(request: Request, env: Env): Promise<Response> {
  const { base, path } = splitBase(new URL(request.url).pathname);

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

  await ensurePlatform(env);
  if (path.startsWith("/admin/api/")) return handleAdminApi(request, env, path.slice("/admin/api".length), `${base}/admin`);

  const match = IVR_ROUTE.exec(path);
  if (match) return handleIvr(request, env, match[1]!, match[2]!);
  return json({ error: "not_found" }, 404);
}

/** כל תשובה לימות היא בפורמט של ימות - גם בשגיאה - כדי שהמתקשר ישמע הודעה ולא "אין מענה משרת API". */
async function handleIvr(request: Request, env: Env, tenantSlug: string, action: string): Promise<Response> {
  const req = await parseYemotRequest(request);
  const isCheck = action === "check";
  const handler = Object.hasOwn(IVR_HANDLERS, action) ? IVR_HANDLERS[action]! : null;

  const tenant = await getTenant(env.DB, tenantSlug);
  if (!tenant || !tenant.is_active || (!isCheck && !handler)) {
    return isCheck ? text("ERROR") : failResponse(req, "השלוחה לא הוגדרה כראוי");
  }

  const db = new TenantDb(env.DB, tenant);
  try {
    if (req.hangup) {
      await db.log(req.phone, req.callId, "hangup", { endpoint: action });
      return text("");
    }
    if (isCheck) return await handleCheck({ db, req });

    if (!(await keyMatches(tenant, req.get("key")))) {
      await db.log(req.phone, req.callId, "config_error", { endpoint: action, problem: "wrong_or_missing_key" });
      return failResponse(req, "השלוחה לא הוגדרה כראוי");
    }
    return await handler!({ db, req });
  } catch (err) {
    console.error("ivr handler error", err);
    await db.log(req.phone, req.callId, "error", { endpoint: action, message: String(err) }).catch(() => {});
    return isCheck ? text("ERROR") : failResponse(req);
  }
}
