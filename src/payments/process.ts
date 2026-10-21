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
  | "subscription_payment_failed"
  | "order_paid"
  | "order_payment_failed";

/**
 * מאתר לאיזו רכישה שייך התשלום:
 * 1. הפניה מפורשת (s123 / o45) אם הספק העביר אותה.
 * 2. טלפון + סכום: הרכישה הממתינה האחרונה של הלקוח בסכום הזה.
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
  return candidates[0] ?? null;
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

  const ok = ev.status === "success";
  const base = {
    amount: ev.amount,
    status: ev.status,
    provider,
    transactionId: ev.transactionId,
    cardLast4: ev.cardLast4,
    installments: ev.installments,
    errorCode: ok ? null : ev.errorCode,
    errorMessage: ok ? null : ev.errorMessage,
  };

  let outcome: Outcome;
  let details: Record<string, unknown>;

  if (target.kind === "order") {
    const { order } = target;
    details = { order_id: order.id, via: target.via };
    const payment = db.insertPayment({ ...base, customerId: order.customer_id, orderId: order.id });
    if (ok && !sameAmount(order.amount, ev.amount)) {
      await payment.run();
      outcome = "amount_mismatch";
    } else if (ok) {
      await db.db.batch([payment, db.markOrderPaid(order.id)]);
      outcome = "order_paid";
    } else {
      await db.db.batch([payment, db.markOrderCancelled(order.id)]);
      outcome = "order_payment_failed";
    }
  } else {
    const { sub } = target;
    details = { subscription_id: sub.id, via: target.via };
    const payment = db.insertPayment({ ...base, customerId: sub.customer_id, subscriptionId: sub.id });
    if (ok && !sameAmount(sub.price, ev.amount)) {
      await payment.run();
      outcome = "amount_mismatch";
    } else if (ok) {
      const course = await db.getCourse(sub.course_id);
      await db.db.batch([payment, db.activateSubscription(sub.id, course?.access_days)]);
      outcome = "subscription_activated";
    } else {
      await db.db.batch([payment, db.markSubscriptionFailed(sub.id)]);
      outcome = "subscription_payment_failed";
    }
  }

  await db.log(logPhone, null, `payment_${outcome}`, { ...details, transaction_id: ev.transactionId, amount: ev.amount, raw: ev.raw });
  return outcome;
}
