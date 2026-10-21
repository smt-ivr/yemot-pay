import type { TenantDb } from "../db/repo";
import type { Order, Subscription } from "../db/types";
import { normalizePhone, sameAmount } from "../lib/util";
import type { PaymentEvent } from "./provider";

type Target =
  | { kind: "subscription"; sub: Subscription; via: string }
  | { kind: "order"; order: Order; via: string };

export type Outcome =
  | "duplicate"
  | "unmatched"
  | "amount_mismatch"
  | "subscription_activated"
  | "subscription_renewed"
  | "subscription_failed_attempt"
  | "order_paid"
  | "order_payment_failed";

/**
 * מאתר לאיזו רכישה שייך החיוב:
 * 1. הפניה מפורשת (s123 / o45) אם הספק העביר אותה.
 * 2. מזהה הוראת קבע ששמור במנוי (חיוב חודשי חוזר).
 * 3. טלפון + סכום: הרכישה הממתינה האחרונה של הלקוח בסכום הזה,
 *    ואם אין - מנוי חודשי שמועד החיוב שלו הגיע באותו סכום.
 */
async function findTarget(db: TenantDb, ev: PaymentEvent): Promise<Target | null> {
  if (ev.reference) {
    const id = Number(ev.reference.slice(1));
    if (ev.reference.startsWith("s")) {
      const sub = await db.getSubscription(id);
      if (sub) return { kind: "subscription", sub, via: "reference" };
    } else {
      const order = await db.getOrder(id);
      if (order) return { kind: "order", order, via: "reference" };
    }
  }

  if (ev.recurringId) {
    const sub = await db.findSubscriptionByToken(ev.recurringId);
    if (sub) return { kind: "subscription", sub, via: "recurring_id" };
  }

  const phone = normalizePhone(ev.phone);
  if (!phone) return null;
  const customer = await db.findCustomerByPhone(phone);
  if (!customer) return null;

  const [subs, orders] = await Promise.all([db.findPendingSubscriptions(customer.id), db.findPendingOrders(customer.id)]);
  const candidates: Target[] = [
    ...subs.filter((s) => sameAmount(s.price, ev.amount)).map((sub) => ({ kind: "subscription" as const, sub, via: "phone_amount" })),
    ...orders.filter((o) => sameAmount(o.amount, ev.amount)).map((order) => ({ kind: "order" as const, order, via: "phone_amount" })),
  ];
  candidates.sort((a, b) => createdAt(b).localeCompare(createdAt(a)));
  if (candidates[0]) return candidates[0];

  const renewable = (await db.findRenewableSubscriptions(customer.id)).find((s) => sameAmount(s.price, ev.amount));
  return renewable ? { kind: "subscription", sub: renewable, via: "phone_amount_renewal" } : null;
}

function createdAt(t: Target): string {
  return t.kind === "subscription" ? t.sub.created_at : t.order.created_at;
}

export async function applyPaymentEvent(db: TenantDb, provider: string, ev: PaymentEvent): Promise<Outcome> {
  const logPhone = normalizePhone(ev.phone) ?? provider;

  if (ev.transactionId && (await db.paymentExists(provider, ev.transactionId))) {
    await db.log(logPhone, null, "payment_callback_duplicate", { transaction_id: ev.transactionId });
    return "duplicate";
  }

  const target = await findTarget(db, ev);
  if (!target) {
    await db.log(logPhone, null, "payment_unmatched", { event: ev });
    return "unmatched";
  }

  const base = {
    amount: ev.amount,
    provider,
    transactionId: ev.transactionId,
    cardLast4: ev.cardLast4,
    installments: ev.installments,
    errorCode: ev.status === "failed" ? ev.errorCode : null,
    errorMessage: ev.status === "failed" ? ev.errorMessage : null,
  };

  let outcome: Outcome;
  let details: Record<string, unknown>;

  if (target.kind === "order") {
    const { order } = target;
    details = { order_id: order.id, via: target.via };
    if (ev.status === "success" && !sameAmount(order.amount, ev.amount)) {
      await db.insertPayment({ ...base, customerId: order.customer_id, orderId: order.id, status: "success" }).run();
      outcome = "amount_mismatch";
    } else if (ev.status === "success") {
      await db.db.batch([
        db.insertPayment({ ...base, customerId: order.customer_id, orderId: order.id, status: "success" }),
        db.markOrderPaid(order.id),
      ]);
      outcome = "order_paid";
    } else {
      await db.insertPayment({ ...base, customerId: order.customer_id, orderId: order.id, status: "failed" }).run();
      outcome = "order_payment_failed";
    }
  } else {
    const { sub } = target;
    details = { subscription_id: sub.id, via: target.via };
    const payment = { ...base, customerId: sub.customer_id, subscriptionId: sub.id };
    const isFirstPayment = sub.status === "pending" || sub.status === "cancelled";

    if (ev.status === "failed") {
      await db.db.batch([db.insertPayment({ ...payment, status: "failed" }), db.recordSubscriptionFailure(sub)]);
      outcome = "subscription_failed_attempt";
    } else if (isFirstPayment && !sameAmount(sub.price, ev.amount)) {
      await db.insertPayment({ ...payment, status: "success" }).run();
      outcome = "amount_mismatch";
    } else if (isFirstPayment) {
      const course = await db.getCourse(sub.course_id);
      await db.db.batch([
        db.insertPayment({ ...payment, status: "success" }),
        db.activateSubscription(sub, course?.billing_type ?? "monthly", ev.recurringId),
      ]);
      outcome = "subscription_activated";
    } else {
      await db.db.batch([db.insertPayment({ ...payment, status: "success" }), db.renewSubscription(sub)]);
      outcome = "subscription_renewed";
    }
  }

  await db.log(logPhone, null, `payment_${outcome}`, { ...details, transaction_id: ev.transactionId, amount: ev.amount, raw: ev.raw });
  return outcome;
}
