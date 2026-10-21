import type { Tables } from "../db/tables";

export type EntityName = "courses" | "products" | "customers" | "subscriptions" | "orders" | "payments" | "ivr_log";

export type FieldType = "text" | "longtext" | "phone" | "int" | "real" | "bool" | "enum" | "date" | "datetime" | "ref";

export interface Field {
  name: string;
  label: string;
  type: FieldType;
  required?: boolean;
  options?: { value: string; label: string }[];
  /** עבור ref: לאיזו ישות מפנה */
  ref?: EntityName;
  /** ערך ברירת מחדל כשהשדה ריק ביצירה */
  default?: string;
  /** לא מוצג בטבלה, רק בטופס */
  formOnly?: boolean;
  help?: string;
}

export interface Column {
  name: string;
  label: string;
}

export interface Entity {
  label: string;
  table: keyof Tables;
  /** שדות שאפשר ליצור/לעדכן. רק שמות מכאן נכנסים ל-SQL. */
  fields: Field[];
  /** עמודות לתצוגה ברשימה (כולל עמודות מחושבות מה-select) */
  columns: Column[];
  /** SELECT ... FROM לרשימה, עם הכינוי x לטבלה הראשית */
  select: (t: Tables) => string;
  /** תנאי חיפוש חופשי - כל תנאי עם ? אחד שמקבל את המחרוזת עם % */
  search: (t: Tables) => string[];
  /** עמודות שאפשר לסנן לפיהן בהתאמה מדויקת (בלי כינוי, על x) */
  filters: string[];
  readOnly?: boolean;
  /** אפשר לערוך אבל לא ליצור ידנית */
  noCreate?: boolean;
  hasUpdatedAt?: boolean;
  /** בשורה אחת: האם ניתן למחוק */
  deletable?: boolean;
}

const yesNo = (name: string, label: string): Field => ({ name, label, type: "bool" });

const SUB_STATUS = [
  { value: "pending", label: "ממתין לתשלום" },
  { value: "active", label: "פעיל" },
  { value: "paused", label: "מושהה" },
  { value: "cancelled", label: "בוטל" },
  { value: "failed", label: "תשלום נכשל" },
];

const ORDER_STATUS = [
  { value: "pending", label: "ממתין לתשלום" },
  { value: "paid", label: "שולם" },
  { value: "scheduled", label: "נקבע מועד" },
  { value: "completed", label: "הושלם" },
  { value: "cancelled", label: "בוטל" },
  { value: "refunded", label: "הוחזר" },
];

const PAYMENT_STATUS = [
  { value: "pending", label: "ממתין" },
  { value: "success", label: "הצליח" },
  { value: "failed", label: "נכשל" },
  { value: "refunded", label: "הוחזר" },
];

const PRODUCT_TYPES = [
  { value: "product", label: "מוצר" },
  { value: "meeting", label: "פגישה" },
  { value: "phone_meeting", label: "פגישה טלפונית" },
];

export const ENTITIES: Record<EntityName, Entity> = {
  courses: {
    label: "קורסים",
    table: "courses",
    fields: [
      { name: "name", label: "שם", type: "text", required: true },
      { name: "ivr_code", label: "קוד שלוחה", type: "text", help: "המזהה שנשלח מהשלוחה בפרמטר course" },
      { name: "price", label: "מחיר", type: "real", required: true },
      { name: "access_days", label: "תוקף גישה (ימים)", type: "int", help: "ריק = לצמיתות. למשל 365 = שנה מיום הרכישה" },
      { name: "max_phones", label: "כמה טלפונים לכל רכישה", type: "int", help: "כמה מספרי טלפון הרוכש יכול לשייך לקורס" },
      yesNo("is_active", "פעיל (פתוח לרכישה)"),
      {
        name: "on_inactive",
        label: "כשהקורס לא פעיל - מה עם מי שכבר רכש?",
        type: "enum",
        default: "keep",
        options: [
          { value: "keep", label: "ממשיך לקבל גישה" },
          { value: "block", label: "נחסם, ושומע שהקורס אינו פעיל" },
        ],
      },
      { name: "description", label: "תיאור", type: "longtext", formOnly: true },
    ],
    columns: [
      { name: "id", label: "#" },
      { name: "name", label: "שם" },
      { name: "ivr_code", label: "קוד שלוחה" },
      { name: "price", label: "מחיר" },
      { name: "access_days", label: "תוקף (ימים)" },
      { name: "max_phones", label: "טלפונים" },
      { name: "is_active", label: "פעיל" },
      { name: "active_count", label: "מנויים פעילים" },
    ],
    select: (t) =>
      `SELECT x.*, (SELECT count(*) FROM ${t.subscriptions} s WHERE s.course_id = x.id AND s.status = 'active') AS active_count FROM ${t.courses} x`,
    search: () => ["x.name LIKE ?", "x.ivr_code LIKE ?"],
    filters: ["is_active"],
    deletable: true,
  },

  products: {
    label: "מוצרים ופגישות",
    table: "products",
    fields: [
      { name: "type", label: "סוג", type: "enum", required: true, options: PRODUCT_TYPES },
      { name: "name", label: "שם", type: "text", required: true },
      { name: "ivr_code", label: "קוד שלוחה", type: "text", help: "המזהה שנשלח מהשלוחה בפרמטר product" },
      { name: "price", label: "מחיר", type: "real", required: true },
      { name: "duration_minutes", label: "משך (דקות)", type: "int" },
      yesNo("is_active", "פעיל"),
      { name: "description", label: "תיאור", type: "longtext", formOnly: true },
    ],
    columns: [
      { name: "id", label: "#" },
      { name: "type", label: "סוג" },
      { name: "name", label: "שם" },
      { name: "ivr_code", label: "קוד שלוחה" },
      { name: "price", label: "מחיר" },
      { name: "duration_minutes", label: "משך" },
      { name: "is_active", label: "פעיל" },
    ],
    select: (t) => `SELECT x.* FROM ${t.products} x`,
    search: () => ["x.name LIKE ?", "x.ivr_code LIKE ?"],
    filters: ["type", "is_active"],
    deletable: true,
  },

  customers: {
    label: "רוכשים",
    table: "customers",
    fields: [
      { name: "full_name", label: "שם מלא", type: "text" },
      { name: "main_phone", label: "טלפון ראשי", type: "phone", required: true },
      { name: "email", label: "אימייל", type: "text" },
      { name: "id_number", label: "ת.ז.", type: "text" },
      { name: "notes", label: "הערות", type: "longtext", formOnly: true },
    ],
    columns: [
      { name: "id", label: "#" },
      { name: "full_name", label: "שם" },
      { name: "main_phone", label: "טלפון" },
      { name: "email", label: "אימייל" },
      { name: "active_count", label: "מנויים פעילים" },
      { name: "created_at", label: "נוצר" },
    ],
    select: (t) =>
      `SELECT x.*, (SELECT count(*) FROM ${t.subscriptions} s WHERE s.customer_id = x.id AND s.status = 'active') AS active_count FROM ${t.customers} x`,
    search: () => ["x.full_name LIKE ?", "x.main_phone LIKE ?", "x.email LIKE ?", "x.id_number LIKE ?"],
    filters: [],
    hasUpdatedAt: true,
    deletable: true,
  },

  subscriptions: {
    label: "מנויים לקורסים",
    table: "subscriptions",
    fields: [
      { name: "customer_id", label: "לקוח", type: "ref", ref: "customers", required: true },
      { name: "course_id", label: "קורס", type: "ref", ref: "courses", required: true },
      { name: "status", label: "סטטוס", type: "enum", required: true, options: SUB_STATUS },
      { name: "price", label: "מחיר", type: "real", required: true },
      { name: "start_date", label: "תאריך התחלה", type: "date" },
      { name: "end_date", label: "תוקף עד", type: "date", help: "ריק = לצמיתות" },
    ],
    columns: [
      { name: "id", label: "#" },
      { name: "customer_name", label: "לקוח" },
      { name: "customer_phone", label: "טלפון לקוח" },
      { name: "course_name", label: "קורס" },
      { name: "phones", label: "טלפונים עם גישה" },
      { name: "status", label: "סטטוס" },
      { name: "price", label: "מחיר" },
      { name: "start_date", label: "התחלה" },
      { name: "end_date", label: "תוקף עד" },
    ],
    select: (t) =>
      `SELECT x.*, c.full_name AS customer_name, c.main_phone AS customer_phone, co.name AS course_name,
        (SELECT group_concat(sp.phone, ', ') FROM ${t.subscription_phones} sp WHERE sp.subscription_id = x.id) AS phones
       FROM ${t.subscriptions} x
       LEFT JOIN ${t.customers} c ON c.id = x.customer_id
       LEFT JOIN ${t.courses} co ON co.id = x.course_id`,
    search: (t) => [
      "c.full_name LIKE ?",
      "c.main_phone LIKE ?",
      "co.name LIKE ?",
      `x.id IN (SELECT subscription_id FROM ${t.subscription_phones} WHERE phone LIKE ?)`,
    ],
    filters: ["status", "customer_id", "course_id"],
    hasUpdatedAt: true,
    deletable: true,
  },

  orders: {
    label: "הזמנות",
    table: "orders",
    fields: [
      { name: "customer_id", label: "לקוח", type: "ref", ref: "customers", required: true },
      { name: "product_id", label: "מוצר", type: "ref", ref: "products", required: true },
      { name: "quantity", label: "כמות", type: "int" },
      { name: "amount", label: "סכום", type: "real", required: true },
      { name: "status", label: "סטטוס", type: "enum", required: true, options: ORDER_STATUS },
      { name: "scheduled_at", label: "מועד פגישה", type: "datetime" },
      { name: "contact_phone", label: "טלפון ליצירת קשר", type: "phone" },
      { name: "notes", label: "הערות", type: "longtext", formOnly: true },
    ],
    columns: [
      { name: "id", label: "#" },
      { name: "customer_name", label: "לקוח" },
      { name: "customer_phone", label: "טלפון לקוח" },
      { name: "product_name", label: "מוצר" },
      { name: "amount", label: "סכום" },
      { name: "status", label: "סטטוס" },
      { name: "scheduled_at", label: "מועד" },
      { name: "contact_phone", label: "טלפון לקשר" },
      { name: "created_at", label: "נוצר" },
    ],
    select: (t) =>
      `SELECT x.*, c.full_name AS customer_name, c.main_phone AS customer_phone, p.name AS product_name
       FROM ${t.orders} x
       LEFT JOIN ${t.customers} c ON c.id = x.customer_id
       LEFT JOIN ${t.products} p ON p.id = x.product_id`,
    search: () => ["c.full_name LIKE ?", "c.main_phone LIKE ?", "p.name LIKE ?", "x.contact_phone LIKE ?"],
    filters: ["status", "customer_id", "product_id"],
    hasUpdatedAt: true,
    deletable: true,
  },

  payments: {
    label: "תשלומים",
    table: "payments",
    fields: [{ name: "status", label: "סטטוס", type: "enum", required: true, options: PAYMENT_STATUS }],
    columns: [
      { name: "id", label: "#" },
      { name: "created_at", label: "תאריך" },
      { name: "customer_name", label: "לקוח" },
      { name: "customer_phone", label: "טלפון" },
      { name: "item", label: "עבור" },
      { name: "amount", label: "סכום" },
      { name: "status", label: "סטטוס" },
      { name: "card_last4", label: "כרטיס" },
      { name: "transaction_id", label: "אסמכתא" },
      { name: "error_message", label: "שגיאה" },
    ],
    select: (t) =>
      `SELECT x.*, c.full_name AS customer_name, c.main_phone AS customer_phone,
        COALESCE(co.name, p.name) AS item
       FROM ${t.payments} x
       LEFT JOIN ${t.customers} c ON c.id = x.customer_id
       LEFT JOIN ${t.subscriptions} s ON s.id = x.subscription_id
       LEFT JOIN ${t.courses} co ON co.id = s.course_id
       LEFT JOIN ${t.orders} o ON o.id = x.order_id
       LEFT JOIN ${t.products} p ON p.id = o.product_id`,
    search: () => ["c.full_name LIKE ?", "c.main_phone LIKE ?", "x.transaction_id LIKE ?"],
    filters: ["status", "customer_id", "subscription_id", "order_id"],
    noCreate: true,
    deletable: true,
  },

  ivr_log: {
    label: "יומן שיחות",
    table: "ivr_log",
    fields: [],
    columns: [
      { name: "id", label: "#" },
      { name: "created_at", label: "זמן" },
      { name: "phone", label: "טלפון" },
      { name: "action", label: "פעולה" },
      { name: "details", label: "פרטים" },
      { name: "call_id", label: "מזהה שיחה" },
    ],
    select: (t) => `SELECT x.* FROM ${t.ivr_log} x`,
    search: () => ["x.phone LIKE ?", "x.action LIKE ?", "x.call_id LIKE ?"],
    filters: ["phone", "action"],
    readOnly: true,
  },
};

export function getEntity(name: string): (Entity & { name: EntityName }) | null {
  return Object.hasOwn(ENTITIES, name) ? { ...ENTITIES[name as EntityName], name: name as EntityName } : null;
}
