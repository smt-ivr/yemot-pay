import { notify } from "../email";
import { normalizePhone } from "../lib/util";
import { goToFolder, idListMessage, priceParts, readTap, t, yemotResponse } from "../yemot/response";
import { V, askPhone, exitFolder, failResponse, resolveProduct, type IvrContext } from "./common";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";

const TYPE_LABEL = { product: "", meeting: "פגישה", phone_meeting: "פגישה טלפונית" } as const;

/**
 * שלוחת רכישת מוצר / פגישה / פגישה טלפונית (type=api).
 * פרמטרים: client, key, product, [ok, exit, price, name, type, source]
 *
 * 1. "לרכישת X במחיר Y הקישו 1, ליציאה 2".
 * 2. בפגישה טלפונית: טלפון לתיאום (1 וסולמית = המספר שממנו התקשרו, או הקשת מספר עם אישור).
 * 3. סליקה. OK -> רק עכשיו נוצרים הרוכש, ההזמנה והתשלום, ונשלח מייל לפי הגדרות הלקוח. אחרת לא נוצר כלום.
 */
export async function handleProduct({ db, req, waitUntil }: IvrContext): Promise<Response> {
  const resolved = await resolveProduct(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { product: req.get("product") });
    return failResponse(req, resolved.message);
  }
  const { item: product, price } = resolved;
  const caller = normalizePhone(req.phone);

  const menu = req.get(V.menu);
  if (menu === null) {
    await db.log(req.phone, req.callId, "purchase_offer", { product_id: product.id });
    return yemotResponse(
      readTap([t(`לרכישת ${product.name}`), ...(price > 0 ? [t("במחיר")] : []), ...priceParts(price), t("הקישו 1, ליציאה הקישו 2")], {
        name: V.menu,
        max: 1,
        min: 1,
        digitsAllowed: ["1", "2"],
      }),
    );
  }
  if (menu !== "1") {
    await db.log(req.phone, req.callId, "purchase_declined", { product_id: product.id });
    return yemotResponse(goToFolder(exitFolder(req)));
  }

  let contact = caller;
  if (product.type === "phone_meeting") {
    const asked = await askPhone(req, {
      base: V.contact,
      callerPhone: caller,
      prompt: caller
        ? [t("לתיאום הפגישה במספר שממנו התקשרתם הקישו 1 וסולמית, למספר אחר הקישו את המספר וסולמית")]
        : [t("הקישו מספר טלפון לתיאום הפגישה וסולמית")],
    });
    if ("response" in asked) return asked.response;
    contact = asked.phone;
  }

  const buyerPhone = caller ?? contact;
  if (!buyerPhone) return failResponse(req, "לא ניתן לזהות את מספר הטלפון");
  const free = price <= 0;
  const code = free ? "OK" : paymentCode(req);
  if (code === null) {
    await db.log(req.phone, req.callId, "payment_started", { product_id: product.id, price, contact });
    return startPayment(db, req, price);
  }
  if (code !== "OK") {
    await db.log(req.phone, req.callId, "payment_not_completed", { product_id: product.id, code });
    return paymentNotCompleted(req);
  }

  const tx = transactionId(req);
  if (!(await db.paymentExists(free ? "free" : PROVIDER, tx))) {
    const customer = await db.ensureCustomer(buyerPhone);
    const orderId = await db.createPaidOrder({ customerId: customer.id, productId: product.id, amount: price, contactPhone: contact, payment: { provider: free ? "free" : PROVIDER, transactionId: tx } });
    await db.log(req.phone, req.callId, "payment_success", { order_id: orderId, product_id: product.id, price });
    waitUntil(
      notify(
        db,
        product.type,
        { product: product.name, price: `${price} ₪`, buyer_phone: caller ?? "חסוי", contact_phone: contact ?? "", reference: String(orderId) },
        { idempotencyKey: `${db.tenant.slug}-order-${orderId}` },
      ),
    );
  }
  const done =
    product.type === "product"
      ? [t(`רכשת בהצלחה את ${product.name}`)]
      : [t(`ה${TYPE_LABEL[product.type]} נרכשה בהצלחה`), t("ניצור איתך קשר לתיאום המועד")];
  return yemotResponse(idListMessage(done), goToFolder(req.get("ok") ?? exitFolder(req)));
}
