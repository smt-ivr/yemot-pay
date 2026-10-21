export interface TenantConfig {
  /** המזהה שמופיע בנתיב ה-URL */
  slug: string;
  /** שם לתצוגה במערכת הניהול */
  title: string;
  /** קידומת הטבלאות במסד */
  prefix: string;
  /** כמה שעות אחרי יצירת רכישה ממתינה עוד משייכים אליה תשלום לפי טלפון וסכום */
  pendingTtlHours: number;
}

/**
 * הרשימה המותרת של לקוחות. זה המקום היחיד שממנו מגיעה קידומת טבלה -
 * קלט מהבקשה משמש רק כמפתח לחיפוש ברשימה הזו.
 */
const TENANTS: Record<string, Omit<TenantConfig, "slug">> = {
  "zeevi-weiss": {
    title: "זאבי וייס",
    prefix: "zeevi_weiss_",
    pendingTtlHours: 24,
  },
};

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const PREFIX_RE = /^[a-z][a-z0-9_]*_$/;

for (const [slug, cfg] of Object.entries(TENANTS)) {
  if (!SLUG_RE.test(slug) || !PREFIX_RE.test(cfg.prefix)) {
    throw new Error(`Invalid tenant config: ${slug}`);
  }
}

export function resolveTenant(slug: string): TenantConfig | null {
  if (!SLUG_RE.test(slug) || !Object.hasOwn(TENANTS, slug)) return null;
  return { slug, ...TENANTS[slug]! };
}

export function allTenants(): TenantConfig[] {
  return Object.keys(TENANTS).map((slug) => resolveTenant(slug)!);
}
