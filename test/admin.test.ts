import { SELF } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://smti.uk/yemot-pay";
const DB = (env as unknown as { DB: D1Database }).DB;
let cookie = "";

async function api(path: string, method = "GET", body?: unknown) {
  const res = await SELF.fetch(`${ORIGIN}/admin/api${path}`, {
    method,
    headers: { ...(body !== undefined ? { "content-type": "application/json" } : {}), ...(cookie ? { cookie } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, data: (await res.json()) as any, headers: res.headers };
}

describe("admin", () => {
  it("serves the admin page and redirects the root", async () => {
    const page = await SELF.fetch(`${ORIGIN}/admin/`);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("ימות פיי · ניהול");
    const root = await SELF.fetch(`${ORIGIN}/`, { redirect: "manual" });
    expect(root.headers.get("location")).toBe(`${ORIGIN}/admin/`);
  });

  it("requires login", async () => {
    expect((await api("/meta")).status).toBe(401);
    expect((await api("/login", "POST", { password: "wrong" })).status).toBe(401);
  });

  it("logs in with the password and sets a scoped cookie", async () => {
    const r = await api("/login", "POST", { password: "admin-test-password" });
    expect(r.status).toBe(200);
    const setCookie = r.headers.get("set-cookie")!;
    expect(setCookie).toContain("Path=/yemot-pay/admin");
    expect(setCookie).toContain("HttpOnly");
    cookie = setCookie.split(";")[0]!;
    const meta = await api("/meta");
    expect(meta.data.tenants).toHaveLength(1);
    expect(meta.data.tenants[0]).toMatchObject({ slug: "zeevi-weiss", title: "זאבי וייס", prefix: "zeevi_weiss_", api_key: "test-key-0123456789abcdef" });
  });

  it("rejects a forged cookie", async () => {
    const saved = cookie;
    cookie = "yp_admin=9999999999.AAAA";
    expect((await api("/meta")).status).toBe(401);
    cookie = saved;
  });

  it("creates, lists and updates a course", async () => {
    const created = await api("/zeevi-weiss/courses", "POST", { name: "משניות", ivr_code: "m10", price: "80", access_days: "", is_active: true });
    expect(created.status).toBe(201);
    const list = await api("/zeevi-weiss/courses?q=משנ");
    expect(list.data.rows).toHaveLength(1);
    expect(list.data.rows[0]).toMatchObject({ name: "משניות", price: 80, access_days: null, active_count: 0 });

    expect((await api(`/zeevi-weiss/courses/${created.data.id}`, "PUT", { access_days: "365" })).status).toBe(200);
    const one = await api(`/zeevi-weiss/courses/${created.data.id}`);
    expect(one.data.row.access_days).toBe(365);
  });

  it("rejects invalid values and a duplicate code", async () => {
    expect((await api("/zeevi-weiss/courses", "POST", { name: "x", price: "abc" })).status).toBe(400);
    expect((await api("/zeevi-weiss/courses", "POST", { price: "10" })).status).toBe(400);
    expect((await api("/zeevi-weiss/courses", "POST", { name: "כפול", ivr_code: "m10", price: "1" })).status).toBe(409);
  });

  it("ignores fields that are not in the whitelist", async () => {
    const r = await api("/zeevi-weiss/customers", "POST", { main_phone: "0521234567", full_name: "ישראל", id: 999, "x; DROP TABLE": 1 });
    expect(r.status).toBe(201);
    expect(r.data.id).not.toBe(999);
  });

  it("grants course access manually with phones and validity from the course", async () => {
    const customers = await api("/zeevi-weiss/customers?q=0521234567");
    const customerId = customers.data.rows[0].id;
    const course = (await api("/zeevi-weiss/courses?q=m10")).data.rows[0];

    const r = await api("/zeevi-weiss/subscriptions", "POST", {
      customer_id: customerId,
      course_id: course.id,
      status: "active",
      price: "80",
      start_date: "",
      end_date: "",
      phones: "0521234567, 0537654321",
    });
    expect(r.status).toBe(201);
    const sub = (await api(`/zeevi-weiss/subscriptions/${r.data.id}`)).data.row;
    expect(sub.phone_list).toEqual(["0521234567", "0537654321"]);
    expect(sub.start_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(sub.end_date).not.toBeNull();

    const access = await SELF.fetch(`${ORIGIN}/ivr/check?client=1&ApiPhone=0537654321&course=m10`);
    expect(await access.text()).toBe("OK");

    expect((await api(`/zeevi-weiss/subscriptions/${r.data.id}`, "PUT", { phones: "0521234567" })).status).toBe(200);
    const after = await SELF.fetch(`${ORIGIN}/ivr/check?client=1&ApiPhone=0537654321&course=m10`);
    expect(await after.text()).toBe("Out");

    const detail = await api(`/zeevi-weiss/customers/${customerId}`);
    expect(detail.data.related.subscriptions).toHaveLength(1);
  });


  it("returns dashboard stats and keeps the log read-only", async () => {
    const stats = await api("/zeevi-weiss/stats");
    expect(stats.data.counts.active_subscriptions).toBeGreaterThan(0);
    expect((await api("/zeevi-weiss/ivr_log", "POST", { phone: "1" })).status).toBe(405);
    expect((await api("/zeevi-weiss/payments", "POST", { status: "success" })).status).toBe(405);
  });

  it("requires JSON for changes", async () => {
    const res = await SELF.fetch(`${ORIGIN}/admin/api/zeevi-weiss/courses`, { method: "POST", headers: { cookie }, body: "name=x" });
    expect(res.status).toBe(415);
  });

  it("creates a new customer (tenant) with its own tables and key", async () => {
    expect((await api("/tenants", "POST", { title: "כהן", slug: "Bad Slug!" })).status).toBe(400);
    expect((await api("/tenants", "POST", { title: "כהן", slug: "cohen", nedarim_mosad_id: "12a" })).status).toBe(400);

    const created = await api("/tenants", "POST", { title: "כהן ספרים", slug: "cohen", nedarim_mosad_id: "1234567", contact_name: "משה" });
    expect(created.status).toBe(201);
    expect(created.data.tenant).toMatchObject({ slug: "cohen", prefix: "cohen_", nedarim_mosad_id: "1234567" });
    expect(created.data.tenant.api_key).toMatch(/^[0-9a-f]{32}$/);
    expect((await api("/tenants", "POST", { title: "שוב", slug: "cohen" })).status).toBe(409);

    // הטבלאות שלו נוצרו ועובדות
    expect((await api("/cohen/courses", "POST", { name: "קורס", ivr_code: "k1", price: "50", is_active: true })).status).toBe(201);
    expect((await api("/cohen/courses")).data.rows).toHaveLength(1);
    expect((await api("/zeevi-weiss/courses?q=קורס")).data.rows).toHaveLength(0);

    const key = created.data.tenant.api_key;
    const offer = await SELF.fetch(`${ORIGIN}/ivr/course?client=2&key=${key}&ApiPhone=0521111111&ApiCallId=x&course=k1`);
    expect(await offer.text()).toMatch(/^read=/);
  });

  it("updates a tenant and rotates its key", async () => {
    expect((await api("/tenants/cohen", "PUT", { nedarim_mosad_id: "7654321", title: "כהן ובניו" })).status).toBe(200);
    const list = (await api("/tenants")).data.rows;
    const cohen = list.find((t: any) => t.slug === "cohen");
    expect(cohen).toMatchObject({ title: "כהן ובניו", nedarim_mosad_id: "7654321" });

    const rotated = await api("/tenants/cohen/key", "POST", {});
    expect(rotated.data.api_key).toMatch(/^[0-9a-f]{32}$/);
    expect(rotated.data.api_key).not.toBe(cohen.api_key);
    const oldKey = await SELF.fetch(`${ORIGIN}/ivr/course?client=2&key=${cohen.api_key}&ApiPhone=0521111111&course=k1`);
    expect(await oldKey.text()).toContain("השלוחה לא הוגדרה כראוי");
  });

  it("rebuilt the phones table so a subscription can have more than two phones", async () => {
    const def = await DB.prepare(
      "SELECT sql FROM sqlite_master WHERE name = 'zeevi_weiss_subscription_phones'",
    ).first<{ sql: string }>();
    expect(def!.sql).toContain("slot >= 1");
  });

  it("limits phones by the course setting and deletes a subscription with payments", async () => {
    const course = await api("/zeevi-weiss/courses", "POST", { name: "שלושה", ivr_code: "three", price: "10", max_phones: "3", is_active: true });
    const customer = await api("/zeevi-weiss/customers", "POST", { main_phone: "0541234567" });
    const tooMany = await api("/zeevi-weiss/subscriptions", "POST", {
      customer_id: customer.data.id, course_id: course.data.id, status: "active", price: "10",
      phones: ["0541234567", "0541234568", "0541234569", "0541234570"],
    });
    expect(tooMany.status).toBe(400);
    const sub = await api("/zeevi-weiss/subscriptions", "POST", {
      customer_id: customer.data.id, course_id: course.data.id, status: "active", price: "10",
      phones: ["0541234567", "0541234568", "0541234569"],
    });
    expect(sub.status).toBe(201);

    await DB.prepare("INSERT INTO zeevi_weiss_payments (customer_id, subscription_id, amount, status) VALUES (?, ?, 10, 'success')")
      .bind(customer.data.id, sub.data.id).run();

    expect((await api(`/zeevi-weiss/subscriptions/${sub.data.id}`, "DELETE", {})).status).toBe(200);
    expect((await api(`/zeevi-weiss/subscriptions/${sub.data.id}`)).status).toBe(404);
    const pay = await DB.prepare("SELECT subscription_id FROM zeevi_weiss_payments WHERE customer_id = ?").bind(customer.data.id).first();
    expect(pay).toEqual({ subscription_id: null });

    // קורס בלי מנויים נמחק; רוכש נמחק עם כל הנתונים שלו
    expect((await api(`/zeevi-weiss/courses/${course.data.id}`, "DELETE", {})).status).toBe(200);
    expect((await api(`/zeevi-weiss/customers/${customer.data.id}`, "DELETE", {})).status).toBe(200);
  });

  it("refuses to delete a course that has subscriptions, with a clear message", async () => {
    const course = (await api("/zeevi-weiss/courses?q=m10")).data.rows[0];
    const r = await api(`/zeevi-weiss/courses/${course.id}`, "DELETE", {});
    expect(r.status).toBe(409);
    expect(r.data.error).toContain("פעיל");
  });

  it("deletes a payment", async () => {
    const customer = await api("/zeevi-weiss/customers", "POST", { main_phone: "0549999999" });
    const row = await DB.prepare("INSERT INTO zeevi_weiss_payments (customer_id, amount, status) VALUES (?, 5, 'success') RETURNING id")
      .bind(customer.data.id).first<{ id: number }>();
    expect((await api(`/zeevi-weiss/payments/${row!.id}`, "DELETE", {})).status).toBe(200);
    expect(await DB.prepare("SELECT 1 FROM zeevi_weiss_payments WHERE id = ?").bind(row!.id).first()).toBeNull();
  });

  it("manages portal users with permissions, limited to their own client", async () => {
    // משתמש של זאבי וייס: צפייה בקורסים, עריכה במנויים, בלי הגדרות
    const created = await api("/tenants/zeevi-weiss/users", "POST", {
      username: "Moshe", display_name: "משה", password: "secret-pass-1",
      permissions: { dashboard: "view", courses: "view", subscriptions: "edit", settings: "none", bogus: "edit" },
    });
    expect(created.status).toBe(201);
    expect((await api("/tenants/zeevi-weiss/users", "POST", { username: "x", password: "secret-pass-1" })).status).toBe(400);
    expect((await api("/tenants/zeevi-weiss/users", "POST", { username: "short", password: "123" })).status).toBe(400);

    const adminCookie = cookie;
    cookie = "";
    expect((await api("/login", "POST", { username: "moshe", password: "wrong-pass" })).status).toBe(401);
    const login = await api("/login", "POST", { username: "moshe", password: "secret-pass-1" });
    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;

    const meta = await api("/meta");
    expect(meta.data.me).toMatchObject({ role: "user", name: "משה", username: "moshe" });
    expect(meta.data.tenants.map((t: any) => t.slug)).toEqual(["zeevi-weiss"]);
    expect(meta.data.permissions).toMatchObject({ courses: "view", subscriptions: "edit", settings: "none", payments: "none" });

    expect((await api("/zeevi-weiss/courses")).status).toBe(200);
    expect((await api("/zeevi-weiss/courses", "POST", { name: "x", price: "1" })).status).toBe(403);
    expect((await api("/zeevi-weiss/payments")).status).toBe(403);
    expect((await api("/zeevi-weiss/email")).status).toBe(403);
    expect((await api("/zeevi-weiss/info")).status).toBe(403);
    expect((await api("/cohen/courses")).status).toBe(403);
    expect((await api("/tenants")).status).toBe(403);
    expect((await api("/platform")).status).toBe(403);

    // חסימת המשתמש מנתקת אותו מיד
    const userCookie = cookie;
    cookie = adminCookie;
    expect((await api(`/tenants/zeevi-weiss/users/${created.data.id}`, "PUT", { is_active: false })).status).toBe(200);
    cookie = userCookie;
    expect((await api("/meta")).status).toBe(401);
    cookie = adminCookie;
  });

  it("saves email settings with validation and keeps the Resend key masked", async () => {
    expect((await api("/zeevi-weiss/email", "PUT", { from_email: "not-an-email" })).status).toBe(400);
    const saved = await api("/zeevi-weiss/email", "PUT", {
      enabled: true, from_name: "זאבי", from_email: "office@example.com", recipients: "a@example.com, b@example.com", reply_to: "",
      subject: "רכישה: {item}", body: "", show_details: true,
    });
    expect(saved.status).toBe(200);
    const got = (await api("/zeevi-weiss/email")).data.settings;
    expect(got).toMatchObject({ enabled: true, from_email: "office@example.com", recipients: "a@example.com, b@example.com", subject: "רכישה: {item}" });
    expect(got.body).toContain("התקבלה רכישה חדשה");

    // תצוגה מקדימה: נושא עם ערכי דוגמה, ועיצוב עם טבלת פרטים
    const preview = await api("/zeevi-weiss/email/preview", "POST", { settings: { ...got, subject: "חדש: {item} ב-{price}" } });
    expect(preview.data.subject).toBe("חדש: גמרא עיון ב-250 ₪");
    expect(preview.data.html).toContain("פרטי הרכישה");
    expect(preview.data.html).toContain("0501234567, 0527654321");

    expect((await api("/platform", "PUT", { resend_api_key: "bad" })).status).toBe(400);
    expect((await api("/platform", "PUT", { resend_api_key: "re_abcdefgh123456" })).status).toBe(200);
    expect((await api("/platform")).data.resend_api_key).toBe("re_a••••3456");
  });

  it("edits the call texts: saves only what changed, and resets to the default", async () => {
    const list = (await api("/zeevi-weiss/texts")).data.texts;
    const offer = list.find((x: any) => x.key === "course_offer");
    expect(offer.default).toContain("{price}");
    expect(offer.value).toBe("");
    const put = await api("/zeevi-weiss/texts", "PUT", { texts: { course_offer: "להרשמה {price} הקישו 1", phone_invalid: "", bogus: "x" } });
    expect(put.status).toBe(200);
    const row = await DB.prepare("SELECT ivr_texts FROM tenants WHERE slug = 'zeevi-weiss'").first<{ ivr_texts: string }>();
    expect(JSON.parse(row!.ivr_texts)).toEqual({ course_offer: "להרשמה {price} הקישו 1" });
    await api("/zeevi-weiss/texts", "PUT", { texts: { course_offer: "" } });
    expect((await DB.prepare("SELECT ivr_texts FROM tenants WHERE slug = 'zeevi-weiss'").first<{ ivr_texts: string | null }>())!.ivr_texts).toBeNull();
  });

  it("products have no type: a new product only takes the caller's phone and sends an email by default", async () => {
    const res = await api("/zeevi-weiss/products", "POST", { name: "שיעור פרטי", ivr_code: "lesson", price: "120", is_active: true });
    expect(res.status).toBe(201);
    const row = await DB.prepare("SELECT type, ask_phone, send_email FROM zeevi_weiss_products WHERE ivr_code = 'lesson'").first();
    expect(row).toEqual({ type: "product", ask_phone: 0, send_email: 1 });
    expect((await api("/zeevi-weiss/products", "POST", { name: "x", price: "1", email_to: "not-an-email" })).status).toBe(400);
  });

  it("gives every client a client number and lets the admin change it", async () => {
    const list = (await api("/tenants")).data.rows;
    expect(list.find((t: any) => t.slug === "zeevi-weiss").client_number).toBe(1);
    expect(list.find((t: any) => t.slug === "cohen").client_number).toBe(2);
    expect((await api("/tenants/cohen", "PUT", { client_number: "1" })).status).toBe(409);
    expect((await api("/tenants/cohen", "PUT", { client_number: "500" })).status).toBe(200);
    const res = await SELF.fetch(`${ORIGIN}/ivr/check?client=500&course=k1&ApiPhone=0521111111`);
    expect(await res.text()).toBe("Out");
  });
});
