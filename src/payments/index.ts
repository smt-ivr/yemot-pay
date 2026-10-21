import { nedarimAdapter } from "./nedarim";
import type { PaymentAdapter } from "./provider";

/** ספקים זמינים לפי השם בנתיב /pay/:tenant/:provider */
const ADAPTERS: Record<string, PaymentAdapter> = {
  nedarim: nedarimAdapter,
};

export function getAdapter(name: string): PaymentAdapter | null {
  return Object.hasOwn(ADAPTERS, name) ? ADAPTERS[name]! : null;
}
