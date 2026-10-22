import { notify } from "../email";
import { normalizePhone } from "../lib/util";
import { goToFolder, idListMessage, readTap, yemotResponse, type Part } from "../yemot/response";
import { V, askPhone, exitFolder, failResponse, resolveProduct, type IvrContext } from "./common";
import { pricePhrase } from "./course";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";
import { sayText, type TextKey } from "./texts";

/**
 * שלוחת רכישת מוצר (type=api). מוצר, פגישה, שיעור - הכל אותו דבר, ההבדל רק בטקסטים שמגדירים.
 * פרמטרים: client, key, product, [ok, exit, price, name, source]
 *
 * 1. "לרכישת X במחיר Y הקישו 1, ליציאה 2" (או טקסט ההצעה שהוגדר במוצר).
 * 2. טלפון ליצירת קשר: המספר שממנו התקשרו. אם במוצר מותר לבחור טלפון אחר (או שהמספר חסוי) -
 *    1 וסולמית = המספר שממנו התקשרו, או הקשת מספר עם אישור.
 * 3. סליקה. OK -> רק עכשיו נוצרים הרוכש, ההזמנה והתשלום, ונשלח מייל לפי ההגדרות. אחרת לא נוצר כלום.
 * 4. טקסט ההצלחה שהוגדר במוצר (או הכללי).
 */
export async function handleProduct({ db, req, waitUntil }: IvrContext): Promise<Response> {
  const resolved = await resolveProduct(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { product: req.get("product") });
    return failResponse(req, resolved.message);
  }
  const { item: product, price } = resolved;
  const caller = normalizePhone(req.phone);
  const say = (key: TextKey, vars?: Record<string, string | Part[]>, override?: string | null) => sayText(db.tenant, key, { name: product.name, ...vars }, override);

  const menu = req.get(V.menu);
  if (menu === null) {
    await db.log(req.phone, req.callId, "purchase_offer", { product_id: product.id });
    return yemotResponse(
      readTap(say("product_offer", { price: pricePhrase(price) }, product.offer_text), { name: V.menu, max: 1, min: 1, digitsAllowed: ["1", "2"] }),
    );
  }
  if (menu !== "1") {
    await db.log(req.phone, req.callId, "purchase_declined", { product_id: product.id });
    return yemotResponse(goToFolder(exitFolder(req)));
  }

  let contact = caller;
  if (product.ask_phone === 1 || !caller) {
    const asked = await askPhone(db, req, {
      base: V.contact,
      callerPhone: caller,
      prompt: caller ? say("product_phone") : say("phone_hidden"),
    });
    if ("response" in asked) return asked.response;
    contact = asked.phone;
  }
  const buyerPhone = caller ?? contact!;

  const free = price <= 0;
  const code = free ? "OK" : paymentCode(req);
  if (code === null) {
    await db.log(req.phone, req.callId, "payment_started", { product_id: product.id, price, contact });
    return startPayment(db, req, price);
  }
  if (code !== "OK") {
    await db.log(req.phone, req.callId, "payment_not_completed", { product_id: product.id, code });
    return paymentNotCompleted(db, req);
  }

  const tx = transactionId(req);
  if (!(await db.paymentExists(free ? "free" : PROVIDER, tx))) {
    const customer = await db.ensureCustomer(buyerPhone);
    const orderId = await db.createPaidOrder({ customerId: customer.id, productId: product.id, amount: price, contactPhone: contact, payment: { provider: free ? "free" : PROVIDER, transactionId: tx } });
    await db.log(req.phone, req.callId, "payment_success", { order_id: orderId, product_id: product.id, price });
    waitUntil(
      notify(
        db,
        product,
        {
          kind: "product",
          item: product.name,
          price: price > 0 ? `${price} ₪` : "ללא תשלום",
          buyer_phone: caller ?? "חסוי",
          phones: contact ?? "",
          reference: String(orderId),
        },
        { idempotencyKey: `${db.tenant.slug}-order-${orderId}` },
      ),
    );
  }
  return yemotResponse(idListMessage(say("product_success", {}, product.success_text)), goToFolder(req.get("ok") ?? exitFolder(req)));
}
