import type { TenantConfig } from "../tenants";
import { tablesFor, type Tables } from "./tables";
import type { Course, Customer, Order, PaymentStatus, Product, ProductType, Subscription } from "./types";
import { addDays, maskSensitive, todayIso } from "../lib/util";

export interface NewPayment {
  customerId: number;
  subscriptionId?: number | null;
  orderId?: number | null;
  amount: number;
  status: PaymentStatus;
  provider: string;
  transactionId?: string | null;
  cardLast4?: string | null;
  installments?: number;
  errorCode?: string | null;
  errorMessage?: string | null;
}

/**
 * גישה לטבלאות של לקוח אחד. שמות הטבלאות מגיעים רק מ-tablesFor,
 * וכל ערך עובר דרך bind.
 */
export class TenantDb {
  readonly t: Tables;

  constructor(
    readonly db: D1Database,
    readonly tenant: TenantConfig,
  ) {
    this.t = tablesFor(tenant);
  }

  // ---------- יומן ----------

  async log(phone: string, callId: string | null, action: string, details?: unknown): Promise<void> {
    await this.db
      .prepare(`INSERT INTO ${this.t.ivr_log} (phone, call_id, action, details) VALUES (?, ?, ?, ?)`)
      .bind(phone || "unknown", callId || null, action, details === undefined ? null : maskSensitive(details))
      .run();
  }

  // ---------- לקוחות ----------

  findCustomerByPhone(phone: string): Promise<Customer | null> {
    return this.db.prepare(`SELECT id, full_name, main_phone FROM ${this.t.customers} WHERE main_phone = ?`).bind(phone).first<Customer>();
  }

  async ensureCustomer(phone: string): Promise<Customer> {
    await this.db.prepare(`INSERT INTO ${this.t.customers} (main_phone) VALUES (?) ON CONFLICT (main_phone) DO NOTHING`).bind(phone).run();
    return (await this.findCustomerByPhone(phone))!;
  }

  // ---------- קורסים ומוצרים ----------

  /** חיפוש לפי ivr_code, שם או מזהה מספרי. */
  findCourse(ref: string): Promise<Course | null> {
    return this.db
      .prepare(
        `SELECT * FROM ${this.t.courses}
         WHERE ivr_code = ?1 OR name = ?1 OR id = CAST(?1 AS INTEGER)
         ORDER BY (ivr_code = ?1) DESC, (name = ?1) DESC LIMIT 1`,
      )
      .bind(ref)
      .first<Course>();
  }

  getCourse(id: number): Promise<Course | null> {
    return this.db.prepare(`SELECT * FROM ${this.t.courses} WHERE id = ?`).bind(id).first<Course>();
  }

  createCourse(c: { name: string; ivrCode: string; price: number }): Promise<Course | null> {
    return this.db
      .prepare(`INSERT INTO ${this.t.courses} (name, ivr_code, billing_type, price) VALUES (?, ?, 'one_time', ?) RETURNING *`)
      .bind(c.name, c.ivrCode, c.price)
      .first<Course>();
  }

  findProduct(ref: string): Promise<Product | null> {
    return this.db
      .prepare(
        `SELECT * FROM ${this.t.products}
         WHERE ivr_code = ?1 OR name = ?1 OR id = CAST(?1 AS INTEGER)
         ORDER BY (ivr_code = ?1) DESC, (name = ?1) DESC LIMIT 1`,
      )
      .bind(ref)
      .first<Product>();
  }

  createProduct(p: { name: string; ivrCode: string; type: ProductType; price: number }): Promise<Product | null> {
    return this.db
      .prepare(`INSERT INTO ${this.t.products} (name, ivr_code, type, price) VALUES (?, ?, ?, ?) RETURNING *`)
      .bind(p.name, p.ivrCode, p.type, p.price)
      .first<Product>();
  }

  // ---------- הרשאת גישה ----------

  async hasCourseAccess(phone: string, courseId: number): Promise<boolean> {
    const row = await this.db
      .prepare(
        `SELECT 1 AS ok FROM ${this.t.subscription_phones} sp
         JOIN ${this.t.subscriptions} s ON s.id = sp.subscription_id
         WHERE sp.phone = ? AND s.course_id = ? AND s.status = 'active'
           AND (s.end_date IS NULL OR s.end_date >= date('now'))
         LIMIT 1`,
      )
      .bind(phone, courseId)
      .first();
    return row !== null;
  }

  /** מצב המנוי של טלפון לקורס: פעיל, פג תוקף, או אין מנוי. */
  async courseAccessStatus(phone: string, courseId: number): Promise<"active" | "expired" | "none"> {
    const row = await this.db
      .prepare(
        `SELECT (s.end_date IS NULL OR s.end_date >= date('now')) AS valid FROM ${this.t.subscription_phones} sp
         JOIN ${this.t.subscriptions} s ON s.id = sp.subscription_id
         WHERE sp.phone = ? AND s.course_id = ? AND s.status = 'active'
         ORDER BY valid DESC LIMIT 1`,
      )
      .bind(phone, courseId)
      .first<{ valid: number }>();
    if (!row) return "none";
    return row.valid ? "active" : "expired";
  }

  // ---------- רכישות ממתינות ----------

  /**
   * תשלום הצליח: יוצר מנוי פעיל עם הטלפונים ורישום התשלום.
   * לפני תשלום מוצלח לא נוצר כלום במסד.
   */
  async createPaidSubscription(o: {
    customerId: number;
    courseId: number;
    price: number;
    phones: string[];
    accessDays: number | null | undefined;
    payment: Omit<NewPayment, "customerId" | "subscriptionId" | "amount" | "status">;
  }): Promise<number> {
    const today = todayIso();
    const end = o.accessDays && o.accessDays > 0 ? addDays(today, o.accessDays) : null;
    const sub = await this.db
      .prepare(
        `INSERT INTO ${this.t.subscriptions} (customer_id, course_id, status, price, start_date, end_date)
         VALUES (?, ?, 'active', ?, ?, ?) RETURNING id`,
      )
      .bind(o.customerId, o.courseId, o.price, today, end)
      .first<{ id: number }>();
    const id = sub!.id;
    try {
      await this.db.batch([
        ...o.phones.map((phone, i) =>
          this.db
            .prepare(`INSERT INTO ${this.t.subscription_phones} (subscription_id, phone, slot) VALUES (?, ?, ?)`)
            .bind(id, phone, i + 1),
        ),
        this.insertPayment({ ...o.payment, customerId: o.customerId, subscriptionId: id, amount: o.price, status: "success" }),
      ]);
    } catch (err) {
      await this.db.prepare(`DELETE FROM ${this.t.subscriptions} WHERE id = ?`).bind(id).run();
      throw err;
    }
    return id;
  }

  /** תשלום הצליח: יוצר הזמנה ששולמה ורישום התשלום. */
  async createPaidOrder(o: {
    customerId: number;
    productId: number;
    amount: number;
    contactPhone: string | null;
    payment: Omit<NewPayment, "customerId" | "orderId" | "amount" | "status">;
  }): Promise<number> {
    const row = await this.db
      .prepare(`INSERT INTO ${this.t.orders} (customer_id, product_id, amount, status, contact_phone) VALUES (?, ?, ?, 'paid', ?) RETURNING id`)
      .bind(o.customerId, o.productId, o.amount, o.contactPhone)
      .first<{ id: number }>();
    try {
      await this.insertPayment({ ...o.payment, customerId: o.customerId, orderId: row!.id, amount: o.amount, status: "success" }).run();
    } catch (err) {
      await this.db.prepare(`DELETE FROM ${this.t.orders} WHERE id = ?`).bind(row!.id).run();
      throw err;
    }
    return row!.id;
  }

  getSubscription(id: number): Promise<Subscription | null> {
    return this.db.prepare(`SELECT * FROM ${this.t.subscriptions} WHERE id = ?`).bind(id).first<Subscription>();
  }

  getOrder(id: number): Promise<Order | null> {
    return this.db.prepare(`SELECT * FROM ${this.t.orders} WHERE id = ?`).bind(id).first<Order>();
  }

  // ---------- תשלומים ----------

  async paymentExists(provider: string, transactionId: string): Promise<boolean> {
    const row = await this.db
      .prepare(`SELECT 1 FROM ${this.t.payments} WHERE provider = ? AND transaction_id = ? LIMIT 1`)
      .bind(provider, transactionId)
      .first();
    return row !== null;
  }

  insertPayment(p: NewPayment): D1PreparedStatement {
    return this.db
      .prepare(
        `INSERT INTO ${this.t.payments}
         (customer_id, subscription_id, order_id, amount, status, provider, transaction_id, card_last4, installments, error_code, error_message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        p.customerId,
        p.subscriptionId ?? null,
        p.orderId ?? null,
        p.amount,
        p.status,
        p.provider,
        p.transactionId ?? null,
        p.cardLast4 ?? null,
        p.installments ?? 1,
        p.errorCode ?? null,
        p.errorMessage ?? null,
      );
  }
}
