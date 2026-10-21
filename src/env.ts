export interface Env {
  DB: D1Database;
  /** סיסמת מערכת הניהול. מוגדרת דרך `wrangler secret put ADMIN_PASSWORD`. */
  ADMIN_PASSWORD: string;
  /**
   * ישן: מפתחות שהוגדרו לפני שהמפתחות עברו למערכת הניהול.
   * משמש רק פעם אחת, כדי שהמפתח של זאבי וייס יישאר כפי שהוגדר בשלוחות.
   */
  TENANT_KEYS?: string;
}
