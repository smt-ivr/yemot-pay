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

  // ---------- רכישות ממתינות ----------

  /** יוצר מנוי pending עם הטלפונים. רכישה ממתינה קודמת של אותו לקוח לאותו קורס מבוטלת. */
  async createPendingSubscription(customerId: number, courseId: number, price: number, phones: string[]): Promise<number> {
    await this.db
      .prepare(
        `UPDATE ${this.t.subscriptions} SET status = 'cancelled', updated_at = datetime('now')
         WHERE customer_id = ? AND course_id = ? AND status = 'pending'`,
      )
      .bind(customerId, courseId)
      .run();

    const sub = await this.db
      .prepare(`INSERT INTO ${this.t.subscriptions} (customer_id, course_id, status, price) VALUES (?, ?, 'pending', ?) RETURNING id`)
      .bind(customerId, courseId, price)
      .first<{ id: number }>();
    const id = sub!.id;

    try {
      await this.db.batch(
        phones.map((phone, i) =>
          this.db
            .prepare(`INSERT INTO ${this.t.subscription_phones} (subscription_id, phone, slot) VALUES (?, ?, ?)`)
            .bind(id, phone, i + 1),
        ),
      );
    } catch (err) {
      await this.db.prepare(`DELETE FROM ${this.t.subscriptions} WHERE id = ?`).bind(id).run();
      throw err;
    }
    return id;
  }

  async createPendingOrder(customerId: number, productId: number, amount: number, contactPhone: string | null): Promise<number> {
    await this.db
      .prepare(
        `UPDATE ${this.t.orders} SET status = 'cancelled', updated_at = datetime('now')
         WHERE customer_id = ? AND product_id = ? AND status = 'pending'`,
      )
      .bind(customerId, productId)
      .run();
    const row = await this.db
      .prepare(`INSERT INTO ${this.t.orders} (customer_id, product_id, amount, status, contact_phone) VALUES (?, ?, ?, 'pending', ?) RETURNING id`)
      .bind(customerId, productId, amount, contactPhone)
      .first<{ id: number }>();
    return row!.id;
  }

  findPendingSubscriptions(customerId: number): Promise<Subscription[]> {
    return this.db
      .prepare(
        `SELECT * FROM ${this.t.subscriptions}
         WHERE customer_id = ? AND status = 'pending' AND created_at >= datetime('now', ?)
         ORDER BY id DESC`,
      )
      .bind(customerId, `-${this.tenant.pendingTtlHours} hours`)
      .all<Subscription>()
      .then((r) => r.results);
  }

  findPendingOrders(customerId: number): Promise<Order[]> {
    return this.db
      .prepare(
        `SELECT * FROM ${this.t.orders}
         WHERE customer_id = ? AND status = 'pending' AND created_at >= datetime('now', ?)
         ORDER BY id DESC`,
      )
      .bind(customerId, `-${this.tenant.pendingTtlHours} hours`)
      .all<Order>()
      .then((r) => r.results);
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

  /** התשלום הצליח: המנוי פעיל מהיום, לצמיתות או לפי תוקף הקורס בימים. */
  activateSubscription(subscriptionId: number, accessDays: number | null | undefined, today = todayIso()): D1PreparedStatement {
    const end = accessDays && accessDays > 0 ? addDays(today, accessDays) : null;
    return this.db
      .prepare(
        `UPDATE ${this.t.subscriptions}
         SET status = 'active', start_date = ?, end_date = ?, updated_at = datetime('now')
         WHERE id = ?`,
      )
      .bind(today, end, subscriptionId);
  }

  /** התשלום נכשל: הרכישה הממתינה מסומנת failed. המתקשר יכול להיכנס שוב ולרכוש מחדש. */
  markSubscriptionFailed(subscriptionId: number): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE ${this.t.subscriptions} SET status = 'failed', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
      .bind(subscriptionId);
  }

  markOrderPaid(orderId: number): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE ${this.t.orders} SET status = 'paid', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
      .bind(orderId);
  }

  markOrderCancelled(orderId: number): D1PreparedStatement {
    return this.db
      .prepare(`UPDATE ${this.t.orders} SET status = 'cancelled', updated_at = datetime('now') WHERE id = ? AND status = 'pending'`)
      .bind(orderId);
  }
}
