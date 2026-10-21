import { readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// הסכמה הקיימת במסד (הטבלאות של זאבי וייס)
const schema = readFileSync(new URL("./test/schema.sql", import.meta.url), "utf8")
  .replace(/^--.*$/gm, "")
  .split(";")
  .map((s) => s.trim())
  .filter(Boolean);

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          // המפתח הישן של זאבי וייס - נטען פעם אחת לטבלת tenants
          TENANT_KEYS: JSON.stringify({ "zeevi-weiss": "test-key-0123456789abcdef" }),
          ADMIN_PASSWORD: "admin-test-password",
          TEST_SCHEMA: schema,
        },
      },
    }),
  ],
  test: {
    setupFiles: ["./test/setup.ts"],
  },
});
