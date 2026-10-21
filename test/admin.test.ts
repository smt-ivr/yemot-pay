import { SELF } from "cloudflare:test";
import { describe, expect, it } from "vitest";

const ORIGIN = "https://smti.uk/yemot-pay";
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
    expect(await page.text()).toContain("ניהול ימות פיי");
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
    expect(meta.data.tenants).toEqual([{ slug: "zeevi-weiss", title: "זאבי וייס" }]);
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

    const access = await SELF.fetch(`${ORIGIN}/ivr/zeevi-weiss/course?key=test-key-0123456789abcdef&ApiPhone=0537654321&course=m10&ok=/1&pay=/2`);
    expect(await access.text()).toBe("go_to_folder=/1");

    expect((await api(`/zeevi-weiss/subscriptions/${r.data.id}`, "PUT", { phones: "0521234567" })).status).toBe(200);
    const after = await SELF.fetch(`${ORIGIN}/ivr/zeevi-weiss/course?key=test-key-0123456789abcdef&ApiPhone=0537654321&course=m10&ok=/1&pay=/2`);
    expect(await after.text()).toMatch(/^read=/);

    const detail = await api(`/zeevi-weiss/customers/${customerId}`);
    expect(detail.data.related.subscriptions).toHaveLength(1);
  });

  it("refuses to delete a customer with linked records", async () => {
    const customerId = (await api("/zeevi-weiss/customers?q=0521234567")).data.rows[0].id;
    expect((await api(`/zeevi-weiss/customers/${customerId}`, "DELETE", {})).status).toBe(409);
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
});
