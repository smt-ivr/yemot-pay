export interface TenantConfig {
  /** המזהה שמופיע בנתיב ה-URL */
  slug: string;
  /** קידומת הטבלאות במסד */
  prefix: string;
  /** אחרי כמה חיובים חוזרים שנכשלו ברציפות המנוי עובר ל-failed */
  maxFailedAttempts: number;
  /** כמה ימים אחרי next_charge_date ממתינים לעדכון חיוב לפני העברה ל-failed */
  graceDays: number;
  /** אחרי כמה שעות רכישה שלא שולמה (pending) מבוטלת */
  pendingTtlHours: number;
}

/**
 * הרשימה המותרת של לקוחות. זה המקום היחיד שממנו מגיעה קידומת טבלה -
 * קלט מהבקשה משמש רק כמפתח לחיפוש ברשימה הזו.
 */
const TENANTS: Record<string, Omit<TenantConfig, "slug">> = {
  "zeevi-weiss": {
    prefix: "zeevi_weiss_",
    maxFailedAttempts: 3,
    graceDays: 5,
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
