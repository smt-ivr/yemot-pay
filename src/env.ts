export interface Env {
  DB: D1Database;
  /**
   * JSON של מפתחות גישה לכל לקוח, למשל {"zeevi-weiss":"<מפתח ארוך ואקראי>"}.
   * מוגדר רק דרך `wrangler secret put TENANT_KEYS`.
   */
  TENANT_KEYS: string;
  /** סיסמת מערכת הניהול. מוגדרת רק דרך `wrangler secret put ADMIN_PASSWORD`. */
  ADMIN_PASSWORD: string;
}
