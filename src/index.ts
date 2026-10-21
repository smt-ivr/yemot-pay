import type { Env } from "./env";
import { handleRequest } from "./router";

export default {
  fetch(request, env, ctx) {
    return handleRequest(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
