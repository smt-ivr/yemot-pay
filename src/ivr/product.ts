import { normalizePhone } from "../lib/util";
import { goToFolder, idListMessage, priceParts, readTap, t, yemotResponse } from "../yemot/response";
import { V, exitFolder, failResponse, resolveProduct, restartResponse, type IvrContext } from "./common";

/**
 * שלוחת רכישת מוצר / פגישה / פגישה טלפונית.
 * פרמטרים מהשלוחה (api_add): key, product, [price, name, type, source], pay, [exit]
 *
 * בפגישה טלפונית נשאל גם טלפון ליצירת קשר. אחרי אישור נוצרת הזמנה pending,
 * והשיחה עוברת לשלוחת התשלום (pay). ההזמנה עוברת ל-paid כשמגיע עדכון תשלום מוצלח.
 */
export async function handleProduct({ db, req }: IvrContext): Promise<Response> {
  const payFolder = req.get("pay");
  if (!payFolder) {
    await db.log(req.phone, req.callId, "config_error", { endpoint: "product", missing: "pay" });
    return failResponse(req, "השלוחה לא הוגדרה כראוי");
  }

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
  const orderId = await db.createPendingOrder(customer.id, product.id, price, contact);
  await db.log(req.phone, req.callId, "purchase_pending", { order_id: orderId, product_id: product.id, price });
  return yemotResponse(idListMessage([t("מעבירים אותך לתשלום")]), goToFolder(payFolder));
}
