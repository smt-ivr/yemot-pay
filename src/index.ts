import type { Env } from "./env";
import { handleRequest } from "./router";

export default {
  fetch(request, env) {
    return handleRequest(request, env);
  },
} satisfies ExportedHandler<Env>;
