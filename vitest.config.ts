import { readdirSync, readFileSync } from "node:fs";
import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

const splitSql = (file: string) =>
  readFileSync(new URL(file, import.meta.url), "utf8")
    .replace(/^--.*$/gm, "")
    .split(";")
    .map((s) => s.trim())
    .filter(Boolean);

// הסכמה הקיימת במסד + המיגרציות שבריפו
const schema = [...splitSql("./test/schema.sql"), ...readdirSync(new URL("./migrations", import.meta.url)).sort().flatMap((f) => splitSql(`./migrations/${f}`))];

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
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
