/**
 * בקשה ממודול API של ימות המשיח.
 * ימות שולחת ApiPhone, ApiCallId, ApiDID, ApiExtension, ובניתוק גם hangup=yes.
 * בתוך אותה שלוחה כל בקשה חוזרת עם כל הערכים שנאספו עד עכשיו (לפי val_name),
 * וגם עם פרמטרים קבועים שהוגדרו בשלוחה ב-api_add_N=name=value.
 * ברירת מחדל GET, או POST כשמוגדר api_url_post=yes.
 */
export interface YemotRequest {
  phone: string;
  callId: string;
  did: string;
  extension: string;
  hangup: boolean;
  get(name: string): string | null;
}

export async function parseYemotRequest(request: Request): Promise<YemotRequest> {
  const params = new Map<string, string>();
  new URL(request.url).searchParams.forEach((v, k) => params.set(k, v));

  if (request.method === "POST") {
    const type = request.headers.get("content-type") ?? "";
    if (type.includes("application/x-www-form-urlencoded") || type.includes("multipart/form-data")) {
      const form = await request.formData();
      form.forEach((v, k) => {
        if (typeof v === "string") params.set(k, v);
      });
    }
  }

  const get = (name: string) => {
    const v = params.get(name);
    return v === undefined || v === "" ? null : v;
  };

  return {
    phone: get("ApiPhone") ?? "",
    callId: get("ApiCallId") ?? "",
    did: get("ApiDID") ?? "",
    extension: get("ApiExtension") ?? "",
    hangup: get("hangup") === "yes",
    get,
  };
}
