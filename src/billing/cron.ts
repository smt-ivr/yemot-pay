import { TenantDb } from "../db/repo";
import type { Env } from "../env";
import { allTenants } from "../tenants";

/**
 * תחזוקה יומית לכל הלקוחות. החיוב החודשי עצמו מתבצע בהוראת הקבע של נדרים פלוס,
 * וכל חיוב מוצלח מקדם את next_charge_date. כאן:
 * 1. רכישות שלא שולמו (pending) אחרי pendingTtlHours מבוטלות.
 * 2. מנוי חודשי פעיל שלא התקבל עבורו חיוב מוצלח עד next_charge_date + graceDays עובר ל-failed
 *    (וכך מאבד גישה). חיוב מוצלח מאוחר יותר מחזיר אותו ל-active.
 */
export async function runDailyMaintenance(env: Env): Promise<void> {
  for (const tenant of allTenants()) {
    const db = new TenantDb(env.DB, tenant);
    try {
      const cancelled = await db.cancelStalePending();
      const failed = await db.failOverdueSubscriptions();
      for (const sub of failed) {
        await db.log("system", null, "subscription_overdue_failed", sub);
      }
      await db.log("system", null, "cron_daily", { cancelled_pending: cancelled, failed_overdue: failed.length });
    } catch (err) {
      console.error(`cron failed for tenant ${tenant.slug}`, err);
    }
  }
}
