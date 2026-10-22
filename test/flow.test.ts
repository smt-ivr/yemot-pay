import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { Env } from "../src/env";
import { addDays, normalizePhone, todayIso } from "../src/lib/util";
import { DEFAULT_EMAIL_SETTINGS, buildEmail } from "../src/email";

const DB = (env as unknown as Env).DB;
const KEY = "test-key-0123456789abcdef";
const ORIGIN = "https://smti.uk/yemot-pay";
const MOSAD = "7006724";

/**
 * כמו שימות שולחת: הפרמטרים של השלוחה בתוך הכתובת (client, course, key), והפרמטרים של ימות
 * מתווספים אחריהם. שלוחת הקורס היא 5, ושלוחת הרכישה היא תת-שלוחה 1 שלה (5/1).
 */
async function ivr(action: string, params: Record<string, string>, key: string | null = KEY): Promise<{ status: number; body: string }> {
  const link = new URLSearchParams({ client: "1", ...(key !== null ? { key } : {}) });
  const yemot = new URLSearchParams({ ApiCallId: "call-1", ApiDID: "0771234567", ApiExtension: "5/1", ...params });
  const res = await SELF.fetch(`${ORIGIN}/ivr/${action}?${link}?${yemot}`);
  return { status: res.status, body: await res.text() };
}
const check = async (phone: string, course = "c1") => (await ivr("check", { ApiPhone: phone, course, ApiExtension: "5" }, null)).body;

const course1 = { course: "c1", name: "גמרא עיון", price: "100" };
/** הטלפון הראשון: 1 = המספר שממנו התקשרו (בלי אישור) */
const callerPhone = { yp_menu: "1", yp_phone1_1: "1" };

beforeAll(async () => {
  await DB.prepare("UPDATE tenants SET nedarim_mosad_id = ? WHERE slug = 'zeevi-weiss'").bind(MOSAD).run();
});

describe("phone validation", () => {
  it("accepts real Israeli numbers only", () => {
    expect(normalizePhone("0501234567")).toBe("0501234567");
    expect(normalizePhone("972501234567")).toBe("0501234567");
    expect(normalizePhone("026234567")).toBe("026234567");
    expect(normalizePhone("021234567")).toBeNull();
    expect(normalizePhone("0771234567")).toBe("0771234567");
    expect(normalizePhone("123")).toBeNull();
    expect(normalizePhone("0123456789")).toBeNull();
    expect(normalizePhone("0601234567")).toBeNull();
    expect(normalizePhone("050123456")).toBeNull();
  });
});

describe("routing", () => {
  it("finds the client by the client number in the link, even with a second ? from Yemot", async () => {
    expect(await check("0503333333")).toBe("Out");
    expect(await (await SELF.fetch(`${ORIGIN}/ivr/check?client=999&course=c1`)).text()).toBe("ERROR");
  });

  it("no longer answers the old /ivr/zeevi-weiss/... links", async () => {
    expect((await SELF.fetch(`${ORIGIN}/ivr/zeevi-weiss/check?course=c1&ApiPhone=0503333333`)).status).toBe(404);
  });

  it("always answers Yemot in Yemot format, never JSON", async () => {
    const wrongKey = await ivr("course", { ApiPhone: "0501234567", ...course1 }, "wrong-key");
    expect(wrongKey.status).toBe(200);
    expect(wrongKey.body).toBe("id_list_message=t-השלוחה לא הוגדרה כראוי&go_to_folder=/");
  });
});

describe("course purchase", () => {
  const caller = { ApiPhone: "0501111111", ...course1 };

  it("offers access without a validity period", async () => {
    const r = await ivr("course", caller);
    expect(r.body).toBe("read=t-אין לך מנוי לקורס גמרא עיון.t-לרכישת גישה לקורס.t-במחיר.n-100.t-שקלים.t-הקישו 1 ליציאה הקישו 2=yp_menu,no,1,1,7,No,no,no,,1.2,,,,");
  });

  it("asks for the first phone with 1 for the calling number", async () => {
    const r = await ivr("course", { ...caller, yp_menu: "1" });
    expect(r.body).toContain("t-לשימוש במספר שממנו התקשרתם הקישו 1 וסולמית למספר אחר הקישו את המספר וסולמית=yp_phone1_1,no,10,1,");
  });

  it("asks again, with a new name, when the number is not valid", async () => {
    const r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1_1: "0601234567" });
    expect(r.body).toContain("t-המספר שהוקש אינו מספר טלפון תקין");
    expect(r.body).toContain("=yp_phone1_2,");
  });

  it("asks to confirm a typed number, and lets the caller retype it", async () => {
    let r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1_1: "0521234567" });
    expect(r.body).toContain("t-הקשתם.d-0521234567.t-לאישור הקישו 1 להקשה מחדש הקישו 2=yp_phone1c_1,");
    r = await ivr("course", { ...caller, yp_menu: "1", yp_phone1_1: "0521234567", yp_phone1c_1: "2" });
    expect(r.body).toContain("=yp_phone1_2,");
  });

  it("does not ask to confirm the calling number (1#)", async () => {
    const r = await ivr("course", { ...caller, ...callerPhone });
    expect(r.body).toContain("t-להוספת מספר נוסף הקישו 1 להמשך הקישו 2=yp_more1,");
  });

  it("checks the second number too (duplicate, then confirm)", async () => {
    let r = await ivr("course", { ...caller, ...callerPhone, yp_more1: "1" });
    expect(r.body).toContain("t-הקישו את המספר הנוסף וסולמית=yp_phone2_1,no,10,9,");
    r = await ivr("course", { ...caller, ...callerPhone, yp_more1: "1", yp_phone2_1: "0501111111" });
    expect(r.body).toContain("t-המספר הזה כבר הוקש");
    r = await ivr("course", { ...caller, ...callerPhone, yp_more1: "1", yp_phone2_1: "0501111111", yp_phone2_2: "0502222222" });
    expect(r.body).toContain("=yp_phone2c_2,");
  });

  const twoPhones = { ...callerPhone, yp_more1: "1", yp_phone2_1: "0502222222", yp_phone2c_1: "1" };

  it("goes to payment, and saves nothing before it succeeds", async () => {
    const r = await ivr("course", { ...caller, ...twoPhones });
    expect(r.body).toBe(`credit_card=nedarim_plus,100,,1,1,,,${MOSAD},,,,,,,GoBack`);
    for (const table of ["customers", "subscriptions", "subscription_phones", "payments"]) {
      expect((await DB.prepare(`SELECT count(*) AS n FROM zeevi_weiss_${table}`).first<{ n: number }>())!.n).toBe(0);
    }
  });

  it("creates everything on CreditCard_CODE=OK and says it was purchased", async () => {
    const r = await ivr("course", { ...caller, ...twoPhones, CreditCard_CODE: "OK" });
    expect(r.body).toBe("id_list_message=t-רכשת בהצלחה את הקורס גמרא עיון&go_to_folder=/5");
    const phones = await DB.prepare("SELECT phone FROM zeevi_weiss_subscription_phones ORDER BY slot").all();
    expect(phones.results).toEqual([{ phone: "0501111111" }, { phone: "0502222222" }]);
    expect(await check("0502222222")).toBe("OK");
    await ivr("course", { ...caller, ...twoPhones, CreditCard_CODE: "OK" });
    expect((await DB.prepare("SELECT count(*) AS n FROM zeevi_weiss_payments").first<{ n: number }>())!.n).toBe(1);
  });

  it("refuses a number that already has a subscription", async () => {
    const r = await ivr("course", { ApiPhone: "0507777777", ApiCallId: "call-7", ...course1, yp_menu: "1", yp_phone1_1: "0502222222" });
    expect(r.body).toContain("t-למספר.d-0502222222.t-כבר יש מנוי לקורס");
  });

  it("creates nothing on a failed payment", async () => {
    const base = { ApiPhone: "0508888888", ApiCallId: "call-2", ...course1, ...callerPhone, yp_more1: "2" };
    expect((await ivr("course", { ...base, CreditCard_CODE: "GoBack" })).body).toBe("id_list_message=t-התשלום לא הושלם&go_to_folder=/");
    expect(await DB.prepare("SELECT 1 FROM zeevi_weiss_customers WHERE main_phone = '0508888888'").first()).toBeNull();
  });
});

describe("course settings", () => {
  it("says the validity in the offer and after the purchase", async () => {
    await DB.prepare("INSERT INTO zeevi_weiss_courses (name, ivr_code, price, access_days, max_phones) VALUES ('הלכה', 'c2', 49.9, 30, 1)").run();
    const base = { ApiPhone: "0504444444", ApiCallId: "call-5", course: "c2" };
    expect((await ivr("course", base)).body).toContain("t-לרכישת גישה לקורס.t-למשך.n-30.t-ימים.t-במחיר.n-49.t-שקלים.t-ו.n-90.t-אגורות");
    const buy = { ...base, ...callerPhone };
    expect((await ivr("course", buy)).body).toMatch(/^credit_card=nedarim_plus,49\.9,/);
    const r = await ivr("course", { ...buy, CreditCard_CODE: "OK" });
    expect(r.body).toBe("id_list_message=t-רכשת בהצלחה את הקורס הלכה.t-המנוי בתוקף ל.n-30.t-ימים&go_to_folder=/5");
    expect(await DB.prepare("SELECT end_date FROM zeevi_weiss_subscriptions ORDER BY id DESC LIMIT 1").first()).toEqual({ end_date: addDays(todayIso(), 30) });
  });

  it("says the subscription expired", async () => {
    await DB.prepare("UPDATE zeevi_weiss_subscriptions SET end_date = date('now', '-1 day') WHERE price = 49.9").run();
    expect(await check("0504444444", "c2")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0504444444", ApiCallId: "call-8", course: "c2" })).body).toContain("t-תוקף המנוי שלך לקורס הלכה הסתיים");
  });

  it("inactive course, keep: buyers keep access, others hear an explanation", async () => {
    await DB.prepare("UPDATE zeevi_weiss_courses SET is_active = 0, on_inactive = 'keep' WHERE ivr_code = 'c1'").run();
    expect(await check("0501111111")).toBe("OK");
    expect(await check("0507070707")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0507070707", course: "c1" })).body).toBe("id_list_message=t-הקורס גמרא עיון אינו פעיל כרגע&go_to_folder=/");
  });

  it("inactive course, block: buyers are blocked too and hear an explanation", async () => {
    await DB.prepare("UPDATE zeevi_weiss_courses SET on_inactive = 'block' WHERE ivr_code = 'c1'").run();
    expect(await check("0501111111")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0501111111", course: "c1" })).body).toBe("id_list_message=t-הקורס גמרא עיון אינו פעיל כרגע&go_to_folder=/");
    await DB.prepare("UPDATE zeevi_weiss_courses SET is_active = 1, on_inactive = 'keep' WHERE ivr_code = 'c1'").run();
  });

  it("blocks access on the expiry date itself (Israel date)", async () => {
    const sub = await DB.prepare("SELECT s.id FROM zeevi_weiss_subscriptions s JOIN zeevi_weiss_subscription_phones p ON p.subscription_id = s.id WHERE p.phone = '0501111111'").first<{ id: number }>();
    await DB.prepare("UPDATE zeevi_weiss_subscriptions SET end_date = ? WHERE id = ?").bind(todayIso(), sub!.id).run();
    expect(await check("0501111111")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0501111111", ApiCallId: "call-x", ...course1 })).body).toContain("t-תוקף המנוי שלך לקורס גמרא עיון הסתיים");
    await DB.prepare("UPDATE zeevi_weiss_subscriptions SET end_date = ? WHERE id = ?").bind(addDays(todayIso(), 1), sub!.id).run();
    expect(await check("0501111111")).toBe("OK");
    await DB.prepare("UPDATE zeevi_weiss_subscriptions SET end_date = NULL WHERE id = ?").bind(sub!.id).run();
  });

  it("a free course (price 0) is purchased right after the phones, without payment", async () => {
    await DB.prepare("INSERT INTO zeevi_weiss_courses (name, ivr_code, price, max_phones) VALUES ('בדיקה', 'free', 0, 1)").run();
    const base = { ApiPhone: "0531234567", ApiCallId: "call-free", course: "free" };
    expect((await ivr("course", base)).body).toContain("t-לרכישת גישה לקורס.t-ללא תשלום.t-הקישו 1");
    const r = await ivr("course", { ...base, yp_menu: "1", yp_phone1_1: "1" });
    expect(r.body).toBe("id_list_message=t-רכשת בהצלחה את הקורס בדיקה&go_to_folder=/5");
    expect(await check("0531234567", "free")).toBe("OK");
    const pay = await DB.prepare("SELECT amount, provider FROM zeevi_weiss_payments WHERE transaction_id = 'yemot-call-free'").first();
    expect(pay).toEqual({ amount: 0, provider: "free" });
  });

  it("explains an unknown course", async () => {
    expect(await check("0504444444", "missing")).toBe("Out");
    expect((await ivr("course", { ApiPhone: "0504444444", course: "missing" })).body).toBe("id_list_message=t-הקורס לא נמצא&go_to_folder=/");
  });
});

describe("product purchase and email", () => {
  afterEach(() => vi.restoreAllMocks());

  /** מיילים שנשלחו ל-Resend בבדיקה */
  function captureEmails() {
    const sent: { body: Record<string, unknown>; headers: Headers }[] = [];
    const realFetch = globalThis.fetch;
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      if (url.startsWith("https://api.resend.com/")) {
        sent.push({ body: JSON.parse(String(init?.body)), headers: new Headers(init?.headers) });
        return Response.json({ id: "email_1" });
      }
      return realFetch(input, init);
    });
    return sent;
  }

  beforeAll(async () => {
    await DB.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('resend_api_key', 're_test_123456789')").run();
    const settings = { enabled: true, recipients: "owner@example.com" };
    await DB.prepare("UPDATE tenants SET email_settings = ? WHERE slug = 'zeevi-weiss'").bind(JSON.stringify(settings)).run();
    // השולח נקבע בהגדרות המערכת
    await DB.batch([
      DB.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('email_from_name', 'SMT')"),
      DB.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('email_from_email', 'office@example.com')"),
      DB.prepare("INSERT OR REPLACE INTO platform_settings (key, value) VALUES ('email_reply_to', 'reply@example.com')"),
    ]);
  });
  afterAll(async () => {
    await DB.prepare("UPDATE tenants SET email_settings = NULL WHERE slug = 'zeevi-weiss'").run();
  });

  it("by default takes the calling number without asking, says the product's own text, and emails a tidy summary", async () => {
    const sent = captureEmails();
    const base = { ApiPhone: "0505555555", ApiCallId: "call-6", product: "m1", name: "פגישת ייעוץ", price: "250" };
    expect((await ivr("product", base)).body).toContain("t-לרכישת פגישת ייעוץ.t-במחיר.n-250.t-שקלים.t-הקישו 1 ליציאה הקישו 2=yp_menu");
    await DB.prepare("UPDATE zeevi_weiss_products SET success_text = ?, email_subject = ? WHERE ivr_code = 'm1'")
      .bind("הפגישה נקבעה בהצלחה, ניצור איתך קשר", "נקבעה {item} מ-{buyer_phone}")
      .run();

    // אין שאלת טלפון: ישר לסליקה
    expect((await ivr("product", { ...base, yp_menu: "1" })).body).toBe(`credit_card=nedarim_plus,250,,1,1,,,${MOSAD},,,,,,,GoBack`);
    const r = await ivr("product", { ...base, yp_menu: "1", CreditCard_CODE: "OK" });
    expect(r.body).toBe("id_list_message=t-הפגישה נקבעה בהצלחה ניצור איתך קשר&go_to_folder=/");
    expect(await DB.prepare("SELECT status, contact_phone FROM zeevi_weiss_orders ORDER BY id DESC LIMIT 1").first()).toEqual({ status: "paid", contact_phone: "0505555555" });

    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]!.body).toMatchObject({ from: "SMT <office@example.com>", reply_to: "reply@example.com", to: ["owner@example.com"], subject: "נקבעה פגישת ייעוץ מ-0505555555" });
    expect(String(sent[0]!.body.text)).toContain("טלפון ליצירת קשר: 0505555555");
    expect(String(sent[0]!.body.html)).toContain("פרטי הרכישה");
    // בלי שם הלקוח, והטלפון מופיע פעם אחת בטבלה
    expect(String(sent[0]!.body.html)).not.toContain("זאבי וייס");
    expect(String(sent[0]!.body.text).split("0505555555").length - 1).toBe(1);
    expect(sent[0]!.headers.get("authorization")).toBe("Bearer re_test_123456789");
  });

  it("asks for a contact number when the product allows another phone", async () => {
    const sent = captureEmails();
    await DB.prepare("UPDATE zeevi_weiss_products SET ask_phone = 1, send_email = 0 WHERE ivr_code = 'm1'").run();
    const base = { ApiPhone: "0505555555", ApiCallId: "call-7", product: "m1" };
    let r = await ivr("product", { ...base, yp_menu: "1" });
    expect(r.body).toContain("t-ליצירת קשר במספר שממנו התקשרתם הקישו 1 וסולמית למספר אחר הקישו את המספר וסולמית=yp_contact_1,");
    r = await ivr("product", { ...base, yp_menu: "1", yp_contact_1: "0506666666" });
    expect(r.body).toContain("t-הקשתם.d-0506666666.t-לאישור הקישו 1 להקשה מחדש הקישו 2=yp_contactc_1,");
    const buy = { ...base, yp_menu: "1", yp_contact_1: "0506666666", yp_contactc_1: "1" };
    expect((await ivr("product", buy)).body).toBe(`credit_card=nedarim_plus,250,,1,1,,,${MOSAD},,,,,,,GoBack`);
    await ivr("product", { ...buy, CreditCard_CODE: "OK" });
    expect(await DB.prepare("SELECT contact_phone FROM zeevi_weiss_orders ORDER BY id DESC LIMIT 1").first()).toEqual({ contact_phone: "0506666666" });
    // במוצר הזה כובה המייל
    await new Promise((res) => setTimeout(res, 50));
    expect(sent).toHaveLength(0);
  });
});

describe("email phone rows", () => {
  const mail = (buyer: string, phones: string) =>
    buildEmail(DEFAULT_EMAIL_SETTINGS, {}, { kind: "product", item: "פגישה", price: "100 ₪", buyer_phone: buyer, phones, reference: "1" }).text;

  it("shows the phone once when it is the calling number", () => {
    const text = mail("0501111111", "0501111111");
    expect(text).toContain("טלפון ליצירת קשר: 0501111111");
    expect(text).not.toContain("הטלפון שממנו התקשרו");
  });

  it("adds the calling number only when the contact phone is different", () => {
    const text = mail("0501111111", "0502222222");
    expect(text).toContain("הטלפון שממנו התקשרו: 0501111111");
    expect(text).toContain("טלפון ליצירת קשר: 0502222222");
  });
});

describe("course without choosing another phone", () => {
  it("uses the calling number as the first phone and goes straight to payment", async () => {
    await ivr("course", { ApiPhone: "0507777777", course: "solo", name: "קורס יחיד", price: "40" });
    await DB.prepare("UPDATE zeevi_weiss_courses SET ask_phone = 0, max_phones = 1 WHERE ivr_code = 'solo'").run();
    const base = { ApiPhone: "0507777777", ApiCallId: "call-solo", course: "solo" };
    expect((await ivr("course", { ...base, yp_menu: "1" })).body).toBe(`credit_card=nedarim_plus,40,,1,1,,,${MOSAD},,,,,,,GoBack`);
    await ivr("course", { ...base, yp_menu: "1", CreditCard_CODE: "OK" });
    expect(await check("0507777777", "solo")).toBe("OK");
  });
});

describe("custom texts", () => {
  it("says the client's own texts, and a course's own offer text", async () => {
    await DB.prepare("UPDATE tenants SET ivr_texts = ? WHERE slug = 'zeevi-weiss'")
      .bind(JSON.stringify({ course_no_sub: "שלום, עדיין לא נרשמת ל{name}" }))
      .run();
    await ivr("course", { ApiPhone: "0508888888", course: "txt", name: "הלכה", price: "30" });
    await DB.prepare("UPDATE zeevi_weiss_courses SET offer_text = ? WHERE ivr_code = 'txt'").bind("להרשמה {price} הקישו 1").run();
    const r = await ivr("course", { ApiPhone: "0508888888", course: "txt" });
    expect(r.body).toContain("read=t-שלום עדיין לא נרשמת להלכה.t-להרשמה.t-במחיר.n-30.t-שקלים.t-הקישו 1=yp_menu");
    await DB.prepare("UPDATE tenants SET ivr_texts = NULL WHERE slug = 'zeevi-weiss'").run();
  });
});
