import { runDailyMaintenance } from "./billing/cron";
import type { Env } from "./env";
import { handleRequest } from "./router";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },

  scheduled(_controller, env, ctx) {
    ctx.waitUntil(runDailyMaintenance(env));
  },
} satisfies ExportedHandler<Env>;
