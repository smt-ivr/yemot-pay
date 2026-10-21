import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import type { Env } from "../src/env";
import { addDays, todayIso } from "../src/lib/util";

const DB = (env as unknown as Env).DB;
const KEY = "test-key-0123456789abcdef";
const ORIGIN = "https://smti.uk/yemot-pay";
const MOSAD = "7006724";

/** שלוחת הקורס היא 5, ושלוחת הרכישה היא תת-שלוחה 1 שלה (5/1) */
async function ivr(action: string, params: Record<string, string>, key: string | null = KEY): Promise<{ status: number; body: string }> {
  const url = new URL(`${ORIGIN}/ivr/zeevi-weiss/${action}`);
  const all: Record<string, string> = { ApiCallId: "call-1", ApiDID: "0771234567", ApiExtension: "5/1", ...params };
  if (key !== null) all.key = key;
  for (const [k, v] of Object.entries(all)) url.searchParams.set(k, v);
  const res = await SELF.fetch(url);
  return { status: res.status, body: await res.text() };
}
const check = async (phone: string, course = "c1") => (await ivr("check", { ApiPhone: phone, course, ApiExtension: "5" }, null)).body;

const course1 = { course: "c1", name: "גמרא עיון", price: "100" };

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
    expect(wrongKey.body).toBe("id_list_message=t-השלוחה לא הוגדרה כראוי&go_to_folder=/");
    expect((await SELF.fetch(`${ORIGIN}/ivr/other/check`).then((r) => r.text()))).toBe("ERROR");
    const log = await DB.prepare("SELECT details FROM zeevi_weiss_ivr_log WHERE action = 'config_error' ORDER BY id DESC LIMIT 1").first<{ details: string }>();
    expect(log!.details).toContain("wrong_or_missing_key");
  });
});

describe("purchase flow", () => {
  const caller = { ApiPhone: "0501111111", ...course1 };

  it("says there is no subscription and offers to buy", async () => {
    const r = await ivr("course", caller);
    expect(r.body).toBe("read=t-אין לך מנוי לקורס גמרא עיון.t-לרכישת גישה לקורס.t-במחיר.n-100.t-שקלים.t-הקישו 1 ליציאה הקישו 2=yp_menu,no,1,1,7,No,no,no,,1.2,,,,");
  });

  it("exits above the course extension when the caller presses 2", async () => {
    expect((await ivr("course", { ...caller, yp_menu: "2" })).body).toBe("go_to_folder=/");
    expect((await ivr("course", { ...caller, yp_menu: "2", ApiExtension: "3/5/1" })).body).toBe("go_to_folder=/3");
  });

  it("asks for the first phone: 1 for the calling number or another number", async () => {
    const r = await ivr("course", { ...caller, yp_menu: "1" });
    expect(r.body).toContain("t-לשימוש במספר שממנו התקשרתם הקישו 1 למספר אחר הקישו את המספר וסולמית=yp_phone1,yes,10,1,");
  });

  it("re-asks on a wrong number", async () => {
    const r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "123" });
    expect(r.body).toContain("t-המספר שהוקש שגוי");
    expect(r.body).toContain("=yp_phone1,yes,");
  });

  it("asks whether to add another number, up to the course limit", async () => {
    let r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "1" });
    expect(r.body).toContain("t-להוספת מספר נוסף הקישו 1 להמשך הקישו 2=yp_more1,");
    r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "1", yp_more1: "1" });
    expect(r.body).toContain("t-הקישו את המספר הנוסף וסולמית=yp_phone2,yes,10,9,");
    r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "1", yp_more1: "1", yp_phone2: "0501111111" });
    expect(r.body).toContain("t-המספר הזה כבר הוקש");
  });

  it("goes straight to payment without a summary (course allows 2 phones)", async () => {
    const r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "1", yp_more1: "1", yp_phone2: "0502222222" });
    expect(r.body).toBe(`credit_card=nedarim_plus,100,,1,1,,,${MOSAD},,,,,,,GoBack`);
    // לפני תשלום מוצלח לא נשמר כלום
    for (const table of ["customers", "subscriptions", "subscription_phones", "payments"]) {
      expect((await DB.prepare(`SELECT count(*) AS n FROM zeevi_weiss_${table}`).first<{ n: number }>())!.n).toBe(0);
    }
    expect(await check("0502222222")).toBe("Out");
  });

  it("says it was purchased successfully and returns to the course", async () => {
    const r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "1", yp_more1: "1", yp_phone2: "0502222222", CreditCard_CODE: "OK" });
    expect(r.body).toBe("id_list_message=t-רכשת בהצלחה את הקורס גמרא עיון&go_to_folder=/5");
    const sub = await DB.prepare("SELECT status, start_date, end_date FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first();
    expect(sub).toEqual({ status: "active", start_date: todayIso(), end_date: null });
    const phones = await DB.prepare("SELECT phone FROM zeevi_weiss_subscription_phones ORDER BY slot").all();
    expect(phones.results).toEqual([{ phone: "0501111111" }, { phone: "0502222222" }]);
    const customer = await DB.prepare("SELECT main_phone FROM zeevi_weiss_customers").all();
    expect(customer.results).toEqual([{ main_phone: "0501111111" }]);
    expect(await check("0501111111")).toBe("OK");
    expect(await check("0502222222")).toBe("OK");
    expect(await check("0503333333")).toBe("Out");
  });

  it("does not record a repeated OK twice", async () => {
    await ivr("course", { ...caller, yp_menu: "1", yp_phone1: "1", yp_more1: "1", yp_phone2: "0502222222", CreditCard_CODE: "OK" });
    const count = await DB.prepare("SELECT count(*) AS n FROM zeevi_weiss_payments WHERE status = 'success'").first<{ n: number }>();
    expect(count!.n).toBe(1);
  });

  it("refuses a number that already has a subscription to the course", async () => {
    const r = await ivr("course", { ApiPhone: "0507777777", ApiCallId: "call-7", ...course1, yp_menu: "1", yp_phone1: "0502222222" });
    expect(r.body).toContain("t-למספר.d-0502222222.t-כבר יש מנוי לקורס");
  });
});

describe("payment not completed", () => {
  it("creates nothing on a failed payment, and the caller can buy again", async () => {
    const base = { ApiPhone: "0508888888", ApiCallId: "call-2", ...course1, yp_menu: "1", yp_phone1: "1", yp_more1: "2" };
    expect((await ivr("course", base)).body).toMatch(/^credit_card=/);
    expect((await ivr("course", { ...base, CreditCard_CODE: "GoBack" })).body).toBe("id_list_message=t-התשלום לא הושלם&go_to_folder=/");
    expect(await check("0508888888")).toBe("Out");
    expect(await DB.prepare("SELECT 1 FROM zeevi_weiss_customers WHERE main_phone = '0508888888'").first()).toBeNull();
    expect(await DB.prepare("SELECT 1 FROM zeevi_weiss_payments WHERE transaction_id = 'yemot-call-2'").first()).toBeNull();

    const again = { ...base, ApiCallId: "call-3" };
    await ivr("course", again);
    expect((await ivr("course", { ...again, CreditCard_CODE: "OK" })).body).toContain("רכשת בהצלחה");
    expect(await check("0508888888")).toBe("OK");
  });

  it("tells the caller when the mosad number is not set", async () => {
    await DB.prepare("UPDATE tenants SET nedarim_mosad_id = NULL WHERE slug = 'zeevi-weiss'").run();
    const r = await ivr("course", { ApiPhone: "0509090909", ApiCallId: "call-4", ...course1, yp_menu: "1", yp_phone1: "1", yp_more1: "2" });
    await DB.prepare("UPDATE tenants SET nedarim_mosad_id = ? WHERE slug = 'zeevi-weiss'").bind(MOSAD).run();
    expect(r.body).toBe("id_list_message=t-הסליקה עדיין לא הוגדרה נסו שוב מאוחר יותר&go_to_folder=/");
  });
});

describe("validity and phone count from the course settings", () => {
  it("uses the DB price, says the validity, and sets the end date", async () => {
    await DB.prepare("INSERT INTO zeevi_weiss_courses (name, ivr_code, price, access_days, max_phones) VALUES ('הלכה', 'c2', 49.9, 30, 1)").run();
    const base = { ApiPhone: "0504444444", ApiCallId: "call-5", course: "c2" };
    expect((await ivr("course", base)).body).toContain("t-לרכישת גישה לקורס.t-למשך.n-30.t-ימים.t-במחיר.n-49.t-שקלים.t-ו.n-90.t-אגורות");
    // קורס עם טלפון אחד: אין שאלה על מספר נוסף
    expect((await ivr("course", { ...base, yp_menu: "1", yp_phone1: "1" })).body).toMatch(/^credit_card=nedarim_plus,49\.9,/);
    const r = await ivr("course", { ...base, yp_menu: "1", yp_phone1: "1", CreditCard_CODE: "OK" });
    expect(r.body).toBe("id_list_message=t-רכשת בהצלחה את הקורס הלכה.t-המנוי בתוקף ל.n-30.t-ימים&go_to_folder=/5");
    const sub = await DB.prepare("SELECT end_date FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first();
    expect(sub).toEqual({ end_date: addDays(todayIso(), 30) });
  });

  it("says the subscription expired after the validity ends", async () => {
    await DB.prepare("UPDATE zeevi_weiss_subscriptions SET end_date = date('now', '-1 day') WHERE price = 49.9").run();
    expect(await check("0504444444", "c2")).toBe("Out");
    const r = await ivr("course", { ApiPhone: "0504444444", ApiCallId: "call-8", course: "c2" });
    expect(r.body).toContain("t-תוקף המנוי שלך לקורס הלכה הסתיים");
  });

  it("allows more than two phones when the course says so", async () => {
    await DB.prepare("INSERT INTO zeevi_weiss_courses (name, ivr_code, price, max_phones) VALUES ('משפחתי', 'c3', 200, 3)").run();
    const base = { ApiPhone: "0521000001", ApiCallId: "call-9", course: "c3", yp_menu: "1", yp_phone1: "1", yp_more1: "1", yp_phone2: "0521000002", yp_more2: "1", yp_phone3: "0521000003" };
    expect((await ivr("course", base)).body).toMatch(/^credit_card=/);
    await ivr("course", { ...base, CreditCard_CODE: "OK" });
    for (const p of ["0521000001", "0521000002", "0521000003"]) expect(await check(p, "c3")).toBe("OK");
  });

  it("explains an unknown course instead of returning silently to the main menu", async () => {
    // check שולח לשלוחת הרכישה, והיא משמיעה את הסיבה
    expect(await check("0504444444", "missing")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0504444444", course: "missing" })).body).toBe("id_list_message=t-הקורס לא נמצא&go_to_folder=/");
  });

  it("explains an inactive course, and keeps access for those who already bought it", async () => {
    await DB.prepare("UPDATE zeevi_weiss_courses SET is_active = 0 WHERE ivr_code = 'c1'").run();
    expect(await check("0507070707")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0507070707", course: "c1" })).body).toBe(
      "id_list_message=t-הקורס גמרא עיון אינו זמין כרגע לרכישה&go_to_folder=/",
    );
    expect(await check("0501111111")).toBe("OK");
    await DB.prepare("UPDATE zeevi_weiss_courses SET is_active = 1 WHERE ivr_code = 'c1'").run();
  });
});

describe("product purchase", () => {
  it("asks for a contact phone for a phone meeting and marks the order paid", async () => {
    const base = { ApiPhone: "0505555555", ApiCallId: "call-6", product: "m1", name: "ייעוץ טלפוני", type: "phone_meeting", price: "250" };
    expect((await ivr("product", base)).body).toContain("=yp_contact,yes,");
    expect((await ivr("product", { ...base, yp_contact: "0506666666" })).body).toContain("=yp_confirm,");
    const buy = { ...base, yp_contact: "0506666666", yp_confirm: "1" };
    expect((await ivr("product", buy)).body).toBe(`credit_card=nedarim_plus,250,,1,1,,,${MOSAD},,,,,,,GoBack`);
    expect((await ivr("product", { ...buy, CreditCard_CODE: "OK" })).body).toContain("התשלום התקבל בהצלחה");
    const order = await DB.prepare("SELECT status, contact_phone FROM zeevi_weiss_orders ORDER BY id DESC LIMIT 1").first();
    expect(order).toEqual({ status: "paid", contact_phone: "0506666666" });
  });
});
