import { env } from "cloudflare:workers";

const testEnv = env as unknown as { DB: D1Database; TEST_SCHEMA: string[] };

const exists = await testEnv.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'zeevi_weiss_customers'").first();
if (!exists) {
  await testEnv.DB.batch(testEnv.TEST_SCHEMA.map((sql) => testEnv.DB.prepare(sql)));
}
