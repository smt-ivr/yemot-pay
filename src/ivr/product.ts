import { normalizePhone } from "../lib/util";
import { goToFolder, idListMessage, priceParts, readTap, t, yemotResponse } from "../yemot/response";
import { V, exitFolder, failResponse, resolveProduct, type IvrContext } from "./common";
import { PROVIDER, paymentCode, paymentNotCompleted, startPayment, transactionId } from "./payment";

/**
 * שלוחת רכישת מוצר / פגישה / פגישה טלפונית (type=api).
 * פרמטרים מהשלוחה (api_add): key, product, [ok, exit, price, name, type, source]
 *
 * בפגישה טלפונית נשאל גם טלפון ליצירת קשר. אחרי אישור השרת עונה credit_card.
 * ימות קוראת שוב עם CreditCard_CODE: OK -> רק עכשיו נוצרים הרוכש, ההזמנה והתשלום. אחרת לא נוצר כלום.
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
    const ask = (problem: string[] = []) =>
      yemotResponse(
        readTap([...problem.map(t), t(`${product.name}`), ...priceParts(price), t("הקישו מספר טלפון לתיאום הפגישה וסולמית")], {
          name: V.contact,
          reEnter: true,
          min: 9,
          max: 10,
        }),
      );
    if (raw === null) return ask();
    contact = normalizePhone(raw);
    if (!contact) return ask(["המספר שהוקש שגוי"]);
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
  const code = paymentCode(req);
  if (code === null) {
    await db.log(req.phone, req.callId, "payment_started", { product_id: product.id, price });
    return startPayment(db, req, price);
  }
  if (code !== "OK") {
    await db.log(req.phone, req.callId, "payment_not_completed", { product_id: product.id, code });
    return paymentNotCompleted(req);
  }

  const tx = transactionId(req);
  if (!(await db.paymentExists(PROVIDER, tx))) {
    const customer = await db.ensureCustomer(buyerPhone);
    const orderId = await db.createPaidOrder({ customerId: customer.id, productId: product.id, amount: price, contactPhone: contact, payment: { provider: PROVIDER, transactionId: tx } });
    await db.log(req.phone, req.callId, "payment_success", { order_id: orderId, product_id: product.id, price });
  }
  return yemotResponse(idListMessage([t("התשלום התקבל בהצלחה, תודה")]), goToFolder(req.get("ok") ?? exitFolder(req)));
}
