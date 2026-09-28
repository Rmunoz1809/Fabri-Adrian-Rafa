// Supabase Edge Function: Botón de Pago Yappy (V2) for Compra Protegida. Two entry points:
//   POST  (from holo.html, with the buyer's session) { order_id }
//         → new_payment_attempt() in the database (checks the order is the buyer's and still
//           payable, and returns the amounts), then Yappy's validate/merchant and payment-wc.
//           Returns { transactionId, token, documentName } for the <btn-yappy> web component.
//   GET   (from Yappy: the IPN) ?orderId&status&hash&domain&confirmationNumber
//         → checks the HMAC hash with the secret key, then confirm_payment() with the service
//           role: the order becomes "paid" and the card "reserved". Safe to receive twice.
// Docs: https://www.yappy.com.pa/comercial/desarrolladores/boton-de-pago-yappy-nueva-integracion/
// The amounts always come from the database (migration 0014), never from the browser.
//
// Secrets (Supabase ▸ Edge Functions ▸ Secrets, never in the page or the repo):
//   YAPPY_MERCHANT_ID   ID del comercio (Yappy Comercial ▸ Botón de pago)
//   YAPPY_SECRET_KEY    Clave secreta generada al crear el botón (base64)
//   YAPPY_DOMAIN        Dominio configurado en el botón, e.g. https://rmunoz1809.github.io
//   YAPPY_ENV           "pruebas" (default) or "produccion"
//   YAPPY_TEST_PHONE    Only in pruebas: the phone registered in Yappy's test program (aliasYappy)
// Deploy (after migration 0014):
//   supabase functions deploy yappy-pago --no-verify-jwt --use-api --project-ref vqcpqoedsyatxswdzqcy
// (--no-verify-jwt because Yappy's IPN has no session; the POST checks the session itself.)
// The IPN URL sent to Yappy is this function's own URL.
import { createClient } from "npm:@supabase/supabase-js@2";

const API = {
  pruebas: "https://api-comecom-uat.yappycloud.com",
  produccion: "https://apipagosbg.bgeneral.cloud",
} as const;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

// Yappy's error codes, in words a buyer understands.
const YAPPY_ERRORS: Record<string, string> = {
  E005: "Ese número no está registrado en Yappy.",
  E007: "Este pago ya se había iniciado. Intenta de nuevo.",
  E010: "El monto no coincide. Recarga la página e intenta de nuevo.",
};

const money = (cents: number) => (cents / 100).toFixed(2);

function config() {
  const env = Deno.env.get("YAPPY_ENV") === "produccion" ? "produccion" : "pruebas";
  const merchantId = Deno.env.get("YAPPY_MERCHANT_ID") ?? "";
  const secret = Deno.env.get("YAPPY_SECRET_KEY") ?? "";
  const domain = (Deno.env.get("YAPPY_DOMAIN") ?? "").replace(/\/+$/, "");
  if (!merchantId || !secret || !domain) return null;
  return { env, api: API[env], merchantId, secret, domain, testPhone: Deno.env.get("YAPPY_TEST_PHONE") ?? "" };
}

async function hmacHex(key: string, data: string) {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

// The hash key is the part before the first "." of the base64-decoded secret key (Yappy's docs).
export async function validHash(secretB64: string, orderId: string, status: string, domain: string, hash: string) {
  let key: string;
  try {
    key = new TextDecoder().decode(Uint8Array.from(atob(secretB64), (c) => c.charCodeAt(0))).split(".")[0];
  } catch {
    return false;
  }
  if (!key) return false;
  return sameText((hash ?? "").toLowerCase(), await hmacHex(key, orderId + status + domain));
}

async function yappy(url: string, body: unknown, token?: string) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15000),
  });
  const data = await res.json().catch(() => null);
  return { ok: res.ok, data };
}

// ---------------------------------------------------------------- IPN (GET from Yappy)
const IPN_STATUS: Record<string, string> = { E: "executed", R: "rejected", C: "cancelled", X: "expired" };

async function ipn(url: URL, cfg: NonNullable<ReturnType<typeof config>>) {
  const q = url.searchParams;
  const orderId = q.get("orderId") ?? "", status = q.get("status") ?? "", domain = q.get("domain") ?? "";
  const hash = q.get("hash") ?? q.get("Hash") ?? "";
  if (!orderId || !status || !domain || !hash) return json({ success: false, error: "missing parameters" }, 400);
  if (!(await validHash(cfg.secret, orderId, status, domain, hash))) {
    console.warn("yappy ipn: bad hash", orderId, status);
    return json({ success: false }, 401);
  }
  const mapped = IPN_STATUS[status];
  if (!mapped) return json({ success: false, error: "unknown status" }, 400);
  const admin = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, {
    auth: { persistSession: false },
  });
  const { data, error } = await admin.rpc("confirm_payment", {
    p_attempt: orderId, p_status: mapped, p_confirmation: q.get("confirmationNumber") ?? null,
  });
  if (error) {
    console.error("yappy ipn: confirm_payment failed", orderId, error);
    return json({ success: false }, 500); // Yappy may retry
  }
  console.log("yappy ipn", orderId, mapped, data);
  return json({ success: true });
}

// ---------------------------------------------------------------- start a payment (POST)
async function startPayment(req: Request, cfg: NonNullable<ReturnType<typeof config>>) {
  let body: { order_id?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud no válida." }, 400);
  }
  const auth = req.headers.get("Authorization") ?? "";
  const apiKey = req.headers.get("apikey") || Deno.env.get("SUPABASE_ANON_KEY") || "";
  if (!/^Bearer\s+\S+\.\S+\.\S+$/i.test(auth) || !body.order_id) return json({ error: "Inicia sesión para pagar." }, 401);
  // Runs as the buyer: new_payment_attempt() checks the order is theirs and still payable.
  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, apiKey, {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });
  const { data: attempt, error } = await supabase.rpc("new_payment_attempt", { p_order: body.order_id, p_provider: "yappy" });
  if (error || !attempt) {
    const msg = String(error?.message ?? "");
    return json({
      error: /not payable/.test(msg) ? "El tiempo para pagar se acabó. Vuelve a la carta e intenta de nuevo."
        : /too many/.test(msg) ? "Demasiados intentos de pago para esta orden. Escríbenos."
        : /not yours|JWT|login/i.test(msg) ? "Inicia sesión para pagar."
        : "No pudimos iniciar el pago. Intenta de nuevo.",
    }, 400);
  }

  const v = await yappy(`${cfg.api}/payments/validate/merchant`, { merchantId: cfg.merchantId, urlDomain: cfg.domain });
  const token = v.data?.body?.token;
  if (!v.ok || !token) {
    console.error("yappy validate failed", v.data?.status);
    return json({ error: "Yappy no está disponible en este momento. Intenta en un rato." }, 502);
  }
  const order = {
    merchantId: cfg.merchantId,
    orderId: attempt.attempt_id,
    domain: cfg.domain,
    paymentDate: v.data?.body?.epochTime ?? Math.floor(Date.now() / 1000),
    ...(cfg.env === "pruebas" && cfg.testPhone ? { aliasYappy: cfg.testPhone } : {}),
    ipnUrl: `${Deno.env.get("SUPABASE_URL")}/functions/v1/yappy-pago`,
    discount: "0.00",
    taxes: money(attempt.taxes_cents),
    subtotal: money(attempt.subtotal_cents),
    total: money(attempt.total_cents),
  };
  const c = await yappy(`${cfg.api}/payments/payment-wc`, order, token);
  const b = c.data?.body;
  if (!c.ok || !b?.transactionId || !b?.token || !b?.documentName) {
    const code = String(c.data?.status?.code ?? "");
    console.error("yappy create order failed", attempt.attempt_id, c.data?.status);
    return json({ error: YAPPY_ERRORS[code] ?? "No pudimos iniciar el pago con Yappy. Intenta de nuevo." }, 502);
  }
  return json({ transactionId: b.transactionId, token: b.token, documentName: b.documentName, attempt: attempt.attempt_id });
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
  const cfg = config();
  if (!cfg) return json({ error: "El pago con Yappy todavía no está configurado." }, 503);
  try {
    if (req.method === "GET") return await ipn(new URL(req.url), cfg);
    if (req.method === "POST") return await startPayment(req, cfg);
    return json({ error: "Método no permitido." }, 405);
  } catch (e) {
    console.error("yappy-pago", e);
    return json({ error: "No pudimos procesar el pago. Intenta de nuevo." }, 500);
  }
});
