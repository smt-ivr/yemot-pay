import type { TenantConfig } from "../tenants";

/** רשימה סגורה של שמות טבלאות. שם טבלה נבנה רק מכאן + קידומת מאומתת. */
const TABLES = [
  "customers",
  "courses",
  "products",
  "subscriptions",
  "subscription_phones",
  "orders",
  "payments",
  "ivr_log",
] as const;

export type TableName = (typeof TABLES)[number];
export type Tables = Record<TableName, string>;

export function tablesFor(tenant: TenantConfig): Tables {
  return Object.fromEntries(TABLES.map((name) => [name, `${tenant.prefix}${name}`])) as Tables;
}
