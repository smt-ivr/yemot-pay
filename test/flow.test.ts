import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { addDays, todayIso } from "../src/lib/util";

const DB = (env as unknown as Env).DB;
const KEY = "test-key-0123456789abcdef";
const ORIGIN = "https://smti.uk/yemot-pay";
const MOSAD = "7006724";

async function ivr(action: string, params: Record<string, string>, key: string | null = KEY): Promise<{ status: number; body: string }> {
  const url = new URL(`${ORIGIN}/ivr/zeevi-weiss/${action}`);
  const all: Record<string, string> = { ApiCallId: "call-1", ApiDID: "0771234567", ApiExtension: "6", ...params };
  if (key !== null) all.key = key;
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  const res = await SELF.fetch(url);
  return { status: res.status, body: await res.text() };
}

const course1 = { course: "c1", name: "גמרא עיון", price: "100", ok: "/5" };
const confirmed = (phone1: string, phone2: string) => ({ ...course1, yp_menu: "1", yp_phone1: phone1, yp_phone2: phone2, yp_confirm: "1" });

beforeAll(async () => {
  await DB.prepare("UPDATE tenants SET nedarim_mosad_id = ? WHERE slug = 'zeevi-weiss'").bind(MOSAD).run();
});

describe("routing", () => {
  it("works both under /yemot-pay and at the root", async () => {
    expect((await SELF.fetch(`${ORIGIN}/health`)).status).toBe(200);
    expect((await SELF.fetch("https://worker.test/health")).status).toBe(200);
  });

  it("always answers Yemot in Yemot format, never JSON", async () => {
    const wrongKey = await ivr("course", { ApiPhone: "0501234567", ...course1 }, "wrong-key");
    expect(wrongKey.status).toBe(200);
    expect(wrongKey.body).toBe("id_list_message=t-השלוחה לא הוגדרה כראוי&go_to_folder=hangup");

    const noKey = await ivr("course", { ApiPhone: "0501234567", ...course1 }, null);
    expect(noKey.body).toContain("go_to_folder=hangup");

    const otherTenant = await SELF.fetch(`${ORIGIN}/ivr/other/course?key=${KEY}`);
    expect(await otherTenant.text()).toContain("id_list_message=");
    expect(await (await SELF.fetch(`${ORIGIN}/ivr/other/check`)).text()).toBe("ERROR");
  });

  it("logs a wrong key so it can be seen in the admin", async () => {
    const log = await DB.prepare("SELECT details FROM zeevi_weiss_ivr_log WHERE action = 'config_error' ORDER BY id DESC LIMIT 1").first<{ details: string }>();
    expect(log!.details).toContain("wrong_or_missing_key");
  });
});

describe("course purchase with Nedarim Plus through Yemot", () => {
  const caller = { ApiPhone: "0501111111" };

  it("offers the course to a caller without access", async () => {
    const r = await ivr("course", { ...caller, ...course1 });
    expect(r.body).toMatch(/^read=/);
    expect(r.body).toContain("=yp_menu,no,1,1,7,No,no,no,,1.2,");
    expect(r.body).toContain("n-100");
  });

  it("exits when the caller presses 2", async () => {
    expect((await ivr("course", { ...caller, ...course1, yp_menu: "2", exit: "/0" })).body).toBe("go_to_folder=/0");
  });

  it("collects two phones and confirms", async () => {
    let r = await ivr("course", { ...caller, ...course1, yp_menu: "1" });
    expect(r.body).toContain("=yp_phone1,no,10,9,7,Phone,");
    r = await ivr("course", { ...caller, ...course1, yp_menu: "1", yp_phone1: "0501111111" });
    expect(r.body).toContain("=yp_phone2,no,10,9,7,Phone,");
    r = await ivr("course", { ...caller, ...course1, yp_menu: "1", yp_phone1: "0501111111", yp_phone2: "0502222222" });
    expect(r.body).toContain("=yp_confirm,");
    expect(r.body).toContain("d-0502222222");
  });

  it("sends the caller to Nedarim Plus with the price and mosad number", async () => {
    const r = await ivr("course", { ...caller, ...confirmed("0501111111", "0502222222") });
    expect(r.body).toBe(`credit_card=nedarim_plus,100,,1,1,,,${MOSAD},,,,,,,GoBack`);
    const sub = await DB.prepare("SELECT status, price FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first();
    expect(sub).toEqual({ status: "pending", price: 100 });
    expect((await ivr("check", { ApiPhone: "0502222222", course: "c1" }, null)).body).toBe("Out");
  });

  it("activates permanent access when Yemot returns CreditCard_CODE=OK", async () => {
    const r = await ivr("course", { ...caller, ...confirmed("0501111111", "0502222222"), CreditCard_CODE: "OK" });
    expect(r.body).toBe("id_list_message=t-התשלום התקבל בהצלחה יש לך גישה לקורס&go_to_folder=/5");

    const sub = await DB.prepare("SELECT status, start_date, end_date FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first();
    expect(sub).toEqual({ status: "active", start_date: todayIso(), end_date: null });
    const pay = await DB.prepare("SELECT status, amount, provider, transaction_id FROM zeevi_weiss_payments").all();
    expect(pay.results).toEqual([{ status: "success", amount: 100, provider: "nedarim_plus", transaction_id: "yemot-call-1" }]);

    expect((await ivr("check", { ApiPhone: "0502222222", course: "c1" }, null)).body).toBe("OK");
    expect((await ivr("check", { ApiPhone: "0501111111", course: "c1" }, null)).body).toBe("OK");
    expect((await ivr("check", { ApiPhone: "0503333333", course: "c1" }, null)).body).toBe("Out");
    expect((await ivr("check", { ApiPhone: "0503333333", course: "c1", deny: "no" }, null)).body).toBe("NO");
  });

  it("does not record a repeated OK twice", async () => {
    const r = await ivr("course", { ...caller, ...confirmed("0501111111", "0502222222"), CreditCard_CODE: "OK" });
    expect(r.body).toContain("התשלום התקבל בהצלחה");
    const count = await DB.prepare("SELECT count(*) AS n FROM zeevi_weiss_payments").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("sends a caller who already has access straight to the content", async () => {
    expect((await ivr("course", { ...caller, ...course1 })).body).toBe("go_to_folder=/5");
  });
});

describe("payment not completed", () => {
  it("gives no access on GoBack, and the caller can buy again", async () => {
    const caller = { ApiPhone: "0508888888", ApiCallId: "call-2" };
    await ivr("course", { ...caller, ...confirmed("0508888888", "none") });
    let r = await ivr("course", { ...caller, ...confirmed("0508888888", "none"), CreditCard_CODE: "GoBack" });
    expect(r.body).toBe("id_list_message=t-התשלום לא הושלם&go_to_folder=hangup");
    expect((await ivr("check", { ApiPhone: "0508888888", course: "c1" }, null)).body).toBe("Out");

    const again = { ApiPhone: "0508888888", ApiCallId: "call-3" };
    expect((await ivr("course", { ...again, ...confirmed("0508888888", "none") })).body).toMatch(/^credit_card=/);
    r = await ivr("course", { ...again, ...confirmed("0508888888", "none"), CreditCard_CODE: "OK" });
    expect(r.body).toContain("התשלום התקבל בהצלחה");
    expect((await ivr("check", { ApiPhone: "0508888888", course: "c1" }, null)).body).toBe("OK");
  });

  it("tells the caller when the mosad number is not set", async () => {
    await DB.prepare("UPDATE tenants SET nedarim_mosad_id = NULL WHERE slug = 'zeevi-weiss'").run();
    const r = await ivr("course", { ApiPhone: "0509090909", ApiCallId: "call-4", ...confirmed("0509090909", "none") });
    expect(r.body).toBe("id_list_message=t-הסליקה עדיין לא הוגדרה נסו שוב מאוחר יותר&go_to_folder=hangup");
    await DB.prepare("UPDATE tenants SET nedarim_mosad_id = ? WHERE slug = 'zeevi-weiss'").bind(MOSAD).run();
  });
});

describe("course settings from the database", () => {
  it("uses the DB price and validity", async () => {
    await DB.prepare("INSERT INTO zeevi_weiss_courses (name, ivr_code, price, access_days) VALUES ('הלכה', 'c2', 49.9, 30)").run();
    const base = { ApiPhone: "0504444444", ApiCallId: "call-5", course: "c2" };
    expect((await ivr("course", base)).body).toContain("n-49.t-שקלים.t-ו.n-90.t-אגורות");

    const buy = { ...base, yp_menu: "1", yp_phone1: "0504444444", yp_phone2: "none", yp_confirm: "1" };
    expect((await ivr("course", buy)).body).toBe(`credit_card=nedarim_plus,49.9,,1,1,,,${MOSAD},,,,,,,GoBack`);
    await ivr("course", { ...buy, CreditCard_CODE: "OK" });
    const sub = await DB.prepare("SELECT end_date FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first();
    expect(sub).toEqual({ end_date: addDays(todayIso(), 30) });
  });

  it("denies access after the validity ends", async () => {
    await DB.prepare("UPDATE zeevi_weiss_subscriptions SET end_date = date('now', '-1 day') WHERE price = 49.9").run();
    expect((await ivr("check", { ApiPhone: "0504444444", course: "c2" }, null)).body).toBe("Out");
  });

  it("reports an unknown course", async () => {
    expect((await ivr("course", { ApiPhone: "0504444444", course: "missing" })).body).toContain("go_to_folder=hangup");
    expect((await ivr("check", { ApiPhone: "0504444444", course: "missing" }, null)).body).toBe("ERROR");
  });

  it("restarts the extension on an invalid phone", async () => {
    const r = await ivr("course", { ApiPhone: "0504444444", course: "c2", yp_menu: "1", yp_phone1: "123" });
    expect(r.body).toContain("go_to_folder=/6");
  });
});

describe("product purchase", () => {
  it("asks for a contact phone for a phone meeting and marks the order paid", async () => {
    const base = { ApiPhone: "0505555555", ApiCallId: "call-6", product: "m1", name: "ייעוץ טלפוני", type: "phone_meeting", price: "250" };
    expect((await ivr("product", base)).body).toContain("=yp_contact,");
    expect((await ivr("product", { ...base, yp_contact: "0506666666" })).body).toContain("=yp_confirm,");

    const buy = { ...base, yp_contact: "0506666666", yp_confirm: "1" };
    expect((await ivr("product", buy)).body).toBe(`credit_card=nedarim_plus,250,,1,1,,,${MOSAD},,,,,,,GoBack`);
    expect((await ivr("product", { ...buy, CreditCard_CODE: "OK" })).body).toContain("התשלום התקבל בהצלחה");

    const order = await DB.prepare("SELECT status, contact_phone FROM zeevi_weiss_orders ORDER BY id DESC LIMIT 1").first();
    expect(order).toEqual({ status: "paid", contact_phone: "0506666666" });
  });
});
