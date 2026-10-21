import { normalizePhone } from "../lib/util";
import { goToFolder, idListMessage, priceParts, readTap, t, yemotResponse } from "../yemot/response";
import { V, exitFolder, failResponse, resolveProduct, restartResponse, type IvrContext } from "./common";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";

/**
 * שלוחת רכישת מוצר / פגישה / פגישה טלפונית (type=api).
 * פרמטרים מהשלוחה (api_add): key, product, [ok, exit, price, name, type, source]
 *
 * בפגישה טלפונית נשאל גם טלפון ליצירת קשר. אחרי אישור נוצרת הזמנה pending והשרת עונה credit_card.
 * ימות קוראת שוב עם CreditCard_CODE: OK -> ההזמנה שולמה, אחרת -> בוטלה.
 */
export async function handleProduct({ db, req }: IvrContext): Promise<Response> {
  const resolved = await resolveProduct(db, req);
  if ("error" in resolved) {
    await db.log(req.phone, req.callId, resolved.error, { product: req.get("product") });
    return failResponse(req, resolved.message);
  }
  const { item: product, price } = resolved;
  const caller = normalizePhone(req.phone);

  let contact = caller;
  if (product.type === "phone_meeting") {
    const raw = req.get(V.contact);
    if (raw === null) {
      return yemotResponse(
        readTap([t(`${product.name}`), ...priceParts(price), t("הקישו מספר טלפון לתיאום הפגישה")], {
          name: V.contact,
          playback: "Phone",
          min: 9,
          max: 10,
        }),
      );
    }
    contact = normalizePhone(raw);
    if (!contact) return restartResponse(req, "מספר הטלפון שהוקש אינו תקין");
  }

  const confirm = req.get(V.confirm);
  if (confirm === null) {
    return yemotResponse(
      readTap([t(`לאישור רכישת ${product.name}`), t("במחיר"), ...priceParts(price), t("הקישו 1, לביטול הקישו 2")], {
        name: V.confirm,
        max: 1,
        min: 1,
        digitsAllowed: ["1", "2"],
      }),
    );
  }
  if (confirm !== "1") {
    await db.log(req.phone, req.callId, "purchase_cancelled", { product_id: product.id });
    return yemotResponse(idListMessage([t("הרכישה בוטלה")]), goToFolder(exitFolder(req)));
  }

  const buyerPhone = caller ?? contact;
  if (!buyerPhone) return failResponse(req, "לא ניתן לזהות את מספר הטלפון");
  const customer = await db.ensureCustomer(buyerPhone);
  const code = paymentCode(req);

  if (code === null) {
    const orderId = await db.createPendingOrder(customer.id, product.id, price, contact);
    await db.log(req.phone, req.callId, "purchase_pending", { order_id: orderId, product_id: product.id, price });
    return startPayment(db, req, price);
  }

  const tx = transactionId(req);
  const done = () => yemotResponse(idListMessage([t("התשלום התקבל בהצלחה, תודה")]), goToFolder(req.get("ok") ?? exitFolder(req)));
  if (code === "OK" && (await db.paymentExists(PROVIDER, tx))) return done();

  const pending = (await db.findPendingOrders(customer.id)).find((o) => o.product_id === product.id);
  if (!pending) {
    await db.log(req.phone, req.callId, "payment_without_pending", { code, product_id: product.id });
    return failResponse(req, code === "OK" ? "התשלום התקבל, אך אירעה תקלה ברישום. אנא פנו למשרד" : undefined);
  }

  if (code === "OK") {
    await db.db.batch([
      db.insertPayment({ customerId: customer.id, orderId: pending.id, amount: pending.amount, status: "success", provider: PROVIDER, transactionId: tx }),
      db.markOrderPaid(pending.id),
    ]);
    await db.log(req.phone, req.callId, "payment_success", { order_id: pending.id, amount: pending.amount });
    return done();
  }

  await db.db.batch([
    db.insertPayment({ customerId: customer.id, orderId: pending.id, amount: pending.amount, status: "failed", provider: PROVIDER, transactionId: tx, errorCode: code }),
    db.markOrderCancelled(pending.id),
  ]);
  await db.log(req.phone, req.callId, "payment_not_completed", { order_id: pending.id, code });
  return paymentNotCompleted(req);
}
