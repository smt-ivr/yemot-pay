import { SELF, createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import type { Env } from "../src/env";
import { addMonths, todayIso } from "../src/lib/util";

const testEnv = env as unknown as Env;
const DB = testEnv.DB;
const KEY = "test-key-0123456789abcdef";

async function ivr(action: string, params: Record<string, string>, key = KEY): Promise<{ status: number; body: string }> {
  const url = new URL(`https://worker.test/ivr/zeevi-weiss/${action}`);
  for (const [k, v] of Object.entries({ key, ApiCallId: "call-1", ApiDID: "0771234567", ApiExtension: "9", ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await SELF.fetch(url);
  return { status: res.status, body: await res.text() };
}

async function callback(payload: Record<string, string>): Promise<{ status: number; body: { ok: boolean; outcome?: string } }> {
  const res = await SELF.fetch(`https://worker.test/pay/zeevi-weiss/nedarim?key=${KEY}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(payload),
  });
  return { status: res.status, body: await res.json() };
}

const course1 = { course: "c1", name: "גמרא עיון", price: "100", ok: "/9/2", pay: "/9/1" };

describe("routing and auth", () => {
  it("rejects a missing or wrong key", async () => {
    expect((await ivr("course", { ApiPhone: "0501234567", ...course1 }, "")).status).toBe(403);
    expect((await ivr("course", { ApiPhone: "0501234567", ...course1 }, "wrong-key-wrong-key")).status).toBe(403);
  });

  it("returns 404 for an unknown tenant or action", async () => {
    expect((await SELF.fetch(`https://worker.test/ivr/other/course?key=${KEY}`)).status).toBe(404);
    expect((await SELF.fetch(`https://worker.test/ivr/zeevi-weiss/nope?key=${KEY}`)).status).toBe(404);
    expect((await SELF.fetch(`https://worker.test/ivr/zeevi_weiss_customers;--/course?key=${KEY}`)).status).toBe(404);
  });
});

describe("course purchase flow", () => {
  const caller = { ApiPhone: "0501111111" };

  it("offers the course to a caller without access, creating it from params", async () => {
    const r = await ivr("course", { ...caller, ...course1 });
    expect(r.body).toMatch(/^read=/);
    expect(r.body).toContain("=yp_menu,no,1,1,7,No,no,no,,1.2,");
    expect(r.body).toContain("n-100");
    const course = await DB.prepare("SELECT * FROM zeevi_weiss_courses WHERE ivr_code = 'c1'").first<{ price: number; billing_type: string }>();
    expect(course).toMatchObject({ price: 100, billing_type: "monthly" });
  });

  it("exits when the caller presses 2", async () => {
    const r = await ivr("course", { ...caller, ...course1, yp_menu: "2", exit: "/0" });
    expect(r.body).toBe("go_to_folder=/0");
  });

  it("collects two phones, confirms and moves to payment", async () => {
    let r = await ivr("course", { ...caller, ...course1, yp_menu: "1" });
    expect(r.body).toContain("=yp_phone1,no,10,9,7,Phone,");

    r = await ivr("course", { ...caller, ...course1, yp_menu: "1", yp_phone1: "0501111111" });
    expect(r.body).toContain("=yp_phone2,no,10,9,7,Phone,");
    expect(r.body).toContain(",Ok,none,");

    r = await ivr("course", { ...caller, ...course1, yp_menu: "1", yp_phone1: "0501111111", yp_phone2: "0502222222" });
    expect(r.body).toContain("=yp_confirm,");
    expect(r.body).toContain("d-0501111111");
    expect(r.body).toContain("d-0502222222");

    r = await ivr("course", { ...caller, ...course1, yp_menu: "1", yp_phone1: "0501111111", yp_phone2: "0502222222", yp_confirm: "1" });
    expect(r.body).toBe("id_list_message=t-מעבירים אותך לתשלום&go_to_folder=/9/1");

    const sub = await DB.prepare("SELECT * FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first<{ id: number; status: string; price: number }>();
    expect(sub).toMatchObject({ status: "pending", price: 100 });
    const phones = await DB.prepare("SELECT phone, slot FROM zeevi_weiss_subscription_phones WHERE subscription_id = ? ORDER BY slot")
      .bind(sub!.id)
      .all();
    expect(phones.results).toEqual([
      { phone: "0501111111", slot: 1 },
      { phone: "0502222222", slot: 2 },
    ]);
  });

  it("still denies access while the payment is pending", async () => {
    const r = await ivr("course", { ApiPhone: "0502222222", ...course1 });
    expect(r.body).toMatch(/^read=/);
  });

  it("activates the subscription on a successful payment callback", async () => {
    const r = await callback({ Status: "OK", Amount: "100", TransactionId: "T1", Phone: "0501111111", LastNum: "1234", KevaId: "K1" });
    expect(r.body).toEqual({ ok: true, outcome: "subscription_activated" });

    const sub = await DB.prepare("SELECT * FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first<Record<string, unknown>>();
    expect(sub).toMatchObject({ status: "active", card_token: "K1", start_date: todayIso(), next_charge_date: addMonths(todayIso(), 1) });
    const pay = await DB.prepare("SELECT * FROM zeevi_weiss_payments WHERE transaction_id = 'T1'").first<Record<string, unknown>>();
    expect(pay).toMatchObject({ status: "success", amount: 100, card_last4: "1234", provider: "nedarim_plus" });
  });

  it("grants access to both phones after payment", async () => {
    expect((await ivr("course", { ApiPhone: "0502222222", ...course1 })).body).toBe("go_to_folder=/9/2");
    expect((await ivr("course", { ApiPhone: "0501111111", ...course1 })).body).toBe("go_to_folder=/9/2");
    expect((await ivr("course", { ApiPhone: "0503333333", ...course1 })).body).toMatch(/^read=/);
  });

  it("ignores a duplicate callback", async () => {
    const r = await callback({ Status: "OK", Amount: "100", TransactionId: "T1", Phone: "0501111111", KevaId: "K1" });
    expect(r.body.outcome).toBe("duplicate");
  });

  it("renews on a recurring charge and fails after repeated failures", async () => {
    let r = await callback({ Status: "OK", Amount: "100", TransactionId: "T2", KevaId: "K1" });
    expect(r.body.outcome).toBe("subscription_renewed");
    let sub = await DB.prepare("SELECT * FROM zeevi_weiss_subscriptions WHERE card_token = 'K1'").first<Record<string, unknown>>();
    expect(sub!.next_charge_date).toBe(addMonths(addMonths(todayIso(), 1), 1));

    for (const tx of ["F1", "F2", "F3"]) {
      r = await callback({ Status: "Error", Amount: "100", TransactionId: tx, KevaId: "K1", Message: "סירוב" });
      expect(r.body.outcome).toBe("subscription_failed_attempt");
    }
    sub = await DB.prepare("SELECT * FROM zeevi_weiss_subscriptions WHERE card_token = 'K1'").first<Record<string, unknown>>();
    expect(sub).toMatchObject({ status: "failed", failed_attempts: 3 });
    expect((await ivr("course", { ApiPhone: "0502222222", ...course1 })).body).toMatch(/^read=/);

    r = await callback({ Status: "OK", Amount: "100", TransactionId: "T3", KevaId: "K1" });
    expect(r.body.outcome).toBe("subscription_renewed");
    sub = await DB.prepare("SELECT * FROM zeevi_weiss_subscriptions WHERE card_token = 'K1'").first<Record<string, unknown>>();
    expect(sub).toMatchObject({ status: "active", failed_attempts: 0 });
  });
});

describe("course settings from the database", () => {
  it("uses the DB price when no price param is sent", async () => {
    await DB.prepare("INSERT INTO zeevi_weiss_courses (name, ivr_code, billing_type, price) VALUES ('הלכה', 'c2', 'one_time', 49.9)").run();
    const r = await ivr("course", { ApiPhone: "0504444444", course: "c2", ok: "/5", pay: "/6" });
    expect(r.body).toContain("n-49.t-שקלים.t-ו.n-90.t-אגורות");
    expect(r.body).not.toContain("לחודש");
  });

  it("reports an unknown course in db mode", async () => {
    const r = await ivr("course", { ApiPhone: "0504444444", course: "missing", ok: "/5", pay: "/6" });
    expect(r.body).toContain("go_to_folder=hangup");
  });

  it("restarts the extension on an invalid phone", async () => {
    const r = await ivr("course", { ApiPhone: "0504444444", course: "c2", ok: "/5", pay: "/6", yp_menu: "1", yp_phone1: "123" });
    expect(r.body).toContain("go_to_folder=/9");
  });

  it("allows skipping the second phone", async () => {
    const r = await ivr("course", {
      ApiPhone: "0504444444",
      course: "c2",
      ok: "/5",
      pay: "/6",
      yp_menu: "1",
      yp_phone1: "0504444444",
      yp_phone2: "none",
      yp_confirm: "1",
    });
    expect(r.body).toContain("go_to_folder=/6");
    const sub = await DB.prepare("SELECT id FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first<{ id: number }>();
    const count = await DB.prepare("SELECT count(*) AS n FROM zeevi_weiss_subscription_phones WHERE subscription_id = ?").bind(sub!.id).first<{ n: number }>();
    expect(count!.n).toBe(1);

    const cb = await callback({ Status: "OK", Amount: "49.9", TransactionId: "T-c2", Phone: "0504444444" });
    expect(cb.body.outcome).toBe("subscription_activated");
    const active = await DB.prepare("SELECT next_charge_date FROM zeevi_weiss_subscriptions WHERE id = ?").bind(sub!.id).first<{ next_charge_date: string | null }>();
    expect(active!.next_charge_date).toBeNull();
  });
});

describe("product purchase", () => {
  it("asks for a contact phone for a phone meeting and marks the order paid", async () => {
    const base = { ApiPhone: "0505555555", product: "m1", name: "ייעוץ טלפוני", type: "phone_meeting", price: "250", pay: "/7" };
    let r = await ivr("product", base);
    expect(r.body).toContain("=yp_contact,");

    r = await ivr("product", { ...base, yp_contact: "0506666666" });
    expect(r.body).toContain("=yp_confirm,");

    r = await ivr("product", { ...base, yp_contact: "0506666666", yp_confirm: "1" });
    expect(r.body).toContain("go_to_folder=/7");

    const cb = await callback({ Status: "OK", Amount: "250", TransactionId: "P1", Phone: "0505555555" });
    expect(cb.body.outcome).toBe("order_paid");
    const order = await DB.prepare("SELECT status, contact_phone FROM zeevi_weiss_orders ORDER BY id DESC LIMIT 1").first();
    expect(order).toEqual({ status: "paid", contact_phone: "0506666666" });
  });
});

describe("payment callback edge cases", () => {
  it("logs an unmatched payment without creating a payment row", async () => {
    const r = await callback({ Status: "OK", Amount: "999", TransactionId: "U1", Phone: "0509999999" });
    expect(r.body.outcome).toBe("unmatched");
    expect(await DB.prepare("SELECT 1 FROM zeevi_weiss_payments WHERE transaction_id = 'U1'").first()).toBeNull();
  });

  it("rejects an unparseable payload and logs it masked", async () => {
    const r = await callback({ Foo: "bar", CardNumber: "4580123412341234" });
    expect(r.status).toBe(400);
    const log = await DB.prepare("SELECT details FROM zeevi_weiss_ivr_log WHERE action = 'payment_callback_invalid' ORDER BY id DESC LIMIT 1").first<{ details: string }>();
    expect(log!.details).toContain("************1234");
    expect(log!.details).not.toContain("4580123412341234");
  });

  it("rejects a callback with a wrong key", async () => {
    const res = await SELF.fetch("https://worker.test/pay/zeevi-weiss/nedarim?key=bad", { method: "POST" });
    expect(res.status).toBe(403);
  });
});

describe("daily cron", () => {
  it("fails overdue subscriptions and cancels stale pending purchases", async () => {
    const course = await DB.prepare("SELECT id FROM zeevi_weiss_courses WHERE ivr_code = 'c1'").first<{ id: number }>();
    const cust = await DB.prepare("INSERT INTO zeevi_weiss_customers (main_phone) VALUES ('0507777777') RETURNING id").first<{ id: number }>();
    const overdue = await DB.prepare(
      "INSERT INTO zeevi_weiss_subscriptions (customer_id, course_id, status, price, next_charge_date) VALUES (?, ?, 'active', 100, date('now', '-10 days')) RETURNING id",
    )
      .bind(cust!.id, course!.id)
      .first<{ id: number }>();
    const stale = await DB.prepare(
      "INSERT INTO zeevi_weiss_subscriptions (customer_id, course_id, status, price, created_at) VALUES (?, ?, 'pending', 100, datetime('now', '-2 days')) RETURNING id",
    )
      .bind(cust!.id, course!.id)
      .first<{ id: number }>();

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController(), testEnv, ctx);
    await waitOnExecutionContext(ctx);

    const status = (id: number) => DB.prepare("SELECT status FROM zeevi_weiss_subscriptions WHERE id = ?").bind(id).first<{ status: string }>();
    expect((await status(overdue!.id))!.status).toBe("failed");
    expect((await status(stale!.id))!.status).toBe("cancelled");
  });
});
