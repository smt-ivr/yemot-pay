import { env } from "cloudflare:workers";
import type { Env } from "../src/env";
import { setup } from "../src/tenants";

const testEnv = env as unknown as Env & { TEST_SCHEMA: string[] };

// הטבלאות הקיימות של זאבי וייס (כמו במסד בענן), ואז ההכנה שה-Worker עושה בעצמו
const exists = await testEnv.DB.prepare("SELECT 1 FROM sqlite_master WHERE name = 'zeevi_weiss_customers'").first();
if (!exists) {
  await testEnv.DB.batch(testEnv.TEST_SCHEMA.map((sql) => testEnv.DB.prepare(sql)));
}
await setup(testEnv);
