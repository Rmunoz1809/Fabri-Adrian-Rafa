// HTTP side of the payment Edge Function, independent of Deno and of supabase-js so it can be tested
// in Node. index.ts wires the real database clients and the provider chosen by PAYMENT_PROVIDER.
//   GET  ?orderId&status&hash&domain[&confirmationNumber]   provider notification (IPN)
//   POST { order_id }            with the buyer's session: new payment attempt + provider charge (0029)
//   POST { listing_id, phone? }  with the buyer's session: "Pagar con Yappy" on a card (0043): order #001…
//                                and the charge sent to the buyer's Yappy phone
//   POST ?simular { attempt_id, status }   development only (mock provider + PAYMENT_DEV_SIMULATOR=true)
import { YappyMockProvider } from "./mock.ts";
import {
  PROVIDER_STATUSES,
  ProviderError,
  readNotification,
  type PaymentProvider,
  type ProviderNotification,
  type ProviderStatus,
} from "./provider.ts";
import { YappyProvider } from "./yappy.ts";

export interface RpcResult {
  data: unknown;
  error: { message: string } | null;
}

export interface HandlerDeps {
  provider: PaymentProvider;
  /** This function's public URL: where the provider sends the IPN. */
  ipnUrl: string;
  /** Lets the page simulate E/R/C/X. Only ever true with the mock provider. */
  devSimulator: boolean;
  /** RPC with the caller's session (Authorization header). */
  rpcAsUser(authorization: string, fn: string, args: Record<string, unknown>): Promise<RpcResult>;
  /** RPC with the service role (only for process_payment_notification). */
  rpcAsService(fn: string, args: Record<string, unknown>): Promise<RpcResult>;
}

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, apikey, content-type, x-client-info",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
};
const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { ...CORS, "Content-Type": "application/json" } });

const hasSession = (auth: string) => /^Bearer\s+\S+\.\S+\.\S+$/i.test(auth);

/** Verifies, logs and processes one notification. Every notification is logged by the database. */
export async function handleNotification(deps: HandlerDeps, n: ProviderNotification, raw: Record<string, string>) {
  const v = await deps.provider.verifyNotification(n);
  // process_yappy_notification (0043) sends a sale's charge to the sale and the rest to 0029's function.
  const { data, error } = await deps.rpcAsService("process_yappy_notification", {
    p_attempt: n.orderId,
    p_status: n.status,
    p_domain: n.domain,
    p_hash: n.hash,
    p_valid: v.valid,
    p_confirmation: n.confirmationNumber ?? null,
    p_raw: v.valid ? raw : { ...raw, rejected: v.reason },
    p_provider: deps.provider.name,
  });
  if (error) return json({ success: false }, 500); // the provider retries; processing is idempotent
  if (!v.valid) return json({ success: false, error: v.reason }, v.reason === "missing parameters" ? 400 : 401);
  return json({ success: true, result: data });
}

/** web_checkout()/start_web_payment() errors (0043) in words a buyer understands. need_phone: ask for it. */
export function checkoutError(message: string): { error: string; need_phone?: true; status: number } {
  const m = message;
  return /login required|JWT|not yours/i.test(m) ? { error: "Inicia sesión para pagar.", status: 401 }
    : /phone required/.test(m) ? { error: "Escribe tu celular de Yappy para mandarte el cobro.", need_phone: true, status: 400 }
    : /phone must be a mobile/.test(m) ? { error: "Escribe un celular de Panamá con Yappy, por ejemplo 6123-4567.", need_phone: true, status: 400 }
    : /listing not available/.test(m) ? { error: "Esta carta ya no está disponible.", status: 409 }
    : /own listing/.test(m) ? { error: "No puedes comprar tu propia carta.", status: 400 }
    : /listing on hold/.test(m) ? { error: "Alguien está pagando esta carta en este momento. Intenta de nuevo en unos minutos.", status: 409 }
    : /already paid/.test(m) ? { error: "Ya pagaste esta carta.", status: 409 }
    : /too many attempts/.test(m) ? { error: "Demasiados intentos de pago para esta orden. Escríbenos.", status: 429 }
    : /too many/.test(m) ? { error: "Hiciste muchas órdenes hoy. Escríbenos si necesitas ayuda.", status: 429 }
    : { error: "No pudimos iniciar el pago. Intenta de nuevo.", status: 400 };
}

type WebPayment = {
  attempt_id: string; existing: boolean; alias: string; description: string;
  subtotal_cents: number; taxes_cents: number; total_cents: number;
} & Record<string, unknown>;

// "Pagar con Yappy" on a card (0043): creates the order (#001…) and sends the Yappy charge to the buyer's
// phone. Every answer carries checkout: true, so the page can tell this function from an older deploy.
async function startWebPayment(deps: HandlerDeps, auth: string, body: { listing_id?: string; phone?: string | null }) {
  const { data, error } = await deps.rpcAsUser(auth, "start_web_payment", {
    p_listing: body.listing_id, p_phone: body.phone ?? null, p_provider: deps.provider.name,
  });
  const pay = data as WebPayment | null;
  // Migration 0043 not applied yet: answer without checkout, so the page falls back to the consulta.
  if (/Could not find the function|schema cache|does not exist/i.test(String(error?.message ?? ""))) {
    return json({ error: "El pago todavía no está configurado." }, 503);
  }
  if (error || !pay) {
    const { status, ...e } = checkoutError(String(error?.message ?? ""));
    return json({ checkout: true, ...e }, status);
  }
  const { attempt_id, existing, alias, subtotal_cents, taxes_cents, ...order } = pay;
  if (existing) return json({ checkout: true, order, attempt: attempt_id, existing: true });
  try {
    const session = await deps.provider.createCharge({
      orderId: attempt_id, subtotalCents: subtotal_cents, taxesCents: taxes_cents, totalCents: pay.total_cents,
      ipnUrl: deps.ipnUrl, aliasYappy: alias, description: pay.description,
    });
    return json({ checkout: true, order, attempt: attempt_id, simulated: session.simulated ?? false });
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : "No pudimos mandar el cobro a Yappy. Intenta de nuevo.";
    // Closes the attempt and frees the card; the buyer can fix the phone and try again.
    await deps.rpcAsUser(auth, "web_payment_failed", { p_attempt: attempt_id, p_error: msg });
    return json({ checkout: true, error: msg, order, need_phone: e instanceof ProviderError && e.code === "E005" ? true : undefined }, 502);
  }
}

async function startPayment(deps: HandlerDeps, req: Request) {
  let body: { order_id?: string; listing_id?: string; phone?: string | null };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud no válida." }, 400);
  }
  const auth = req.headers.get("Authorization") ?? "";
  if (body.listing_id) {
    if (!hasSession(auth)) return json({ checkout: true, error: "Inicia sesión para pagar." }, 401);
    return startWebPayment(deps, auth, body);
  }
  if (!hasSession(auth) || !body.order_id) return json({ error: "Inicia sesión para pagar." }, 401);
  // Runs as the buyer: new_payment_attempt() checks the order is theirs and payable, and sets the amount.
  const { data, error } = await deps.rpcAsUser(auth, "new_payment_attempt", { p_order: body.order_id, p_provider: deps.provider.name });
  const attempt = data as { attempt_id: string; subtotal_cents: number; taxes_cents: number; total_cents: number; purpose: string } | null;
  if (error || !attempt) {
    const msg = String(error?.message ?? "");
    return json({
      error: /not payable/.test(msg) ? "El tiempo para pagar se acabó. Vuelve a la carta e intenta de nuevo."
        : /too many/.test(msg) ? "Demasiados intentos de pago para esta orden. Escríbenos."
        : /not yours|JWT|login/i.test(msg) ? "Inicia sesión para pagar."
        : "No pudimos iniciar el pago. Intenta de nuevo.",
    }, 400);
  }
  try {
    const session = await deps.provider.createCharge({
      orderId: attempt.attempt_id,
      subtotalCents: attempt.subtotal_cents,
      taxesCents: attempt.taxes_cents,
      totalCents: attempt.total_cents,
      ipnUrl: deps.ipnUrl,
    });
    return json({ ...session, attempt: attempt.attempt_id, purpose: attempt.purpose, total_cents: attempt.total_cents });
  } catch (e) {
    const msg = e instanceof ProviderError ? e.message : "No pudimos iniciar el pago. Intenta de nuevo.";
    return json({ error: msg }, 502);
  }
}

async function simulate(deps: HandlerDeps, req: Request) {
  if (!deps.devSimulator || !(deps.provider instanceof YappyMockProvider)) return json({ error: "Not found" }, 404);
  if (!hasSession(req.headers.get("Authorization") ?? "")) return json({ error: "Inicia sesión." }, 401);
  let body: { attempt_id?: string; status?: string };
  try {
    body = await req.json();
  } catch {
    return json({ error: "Solicitud no válida." }, 400);
  }
  if (!body.attempt_id || !PROVIDER_STATUSES.includes(body.status as ProviderStatus)) {
    return json({ error: "attempt_id y status (E, R, C o X) son obligatorios." }, 400);
  }
  const n = await deps.provider.simulate(body.attempt_id, body.status as ProviderStatus);
  return handleNotification(deps, n, { ...n, simulated: "true" } as unknown as Record<string, string>);
}

export function createPaymentHandler(deps: HandlerDeps) {
  return async (req: Request): Promise<Response> => {
    if (req.method === "OPTIONS") return new Response("ok", { headers: CORS });
    const url = new URL(req.url);
    try {
      if (req.method === "GET") {
        return await handleNotification(deps, readNotification(url.searchParams), Object.fromEntries(url.searchParams));
      }
      if (req.method === "POST" && url.searchParams.has("simular")) return await simulate(deps, req);
      if (req.method === "POST") return await startPayment(deps, req);
      return json({ error: "Método no permitido." }, 405);
    } catch (e) {
      console.error("payments", e);
      return json({ error: "No pudimos procesar el pago. Intenta de nuevo." }, 500);
    }
  };
}

/** Provider from environment variables (Edge Function secrets, never in the page or the repo). */
export function providerFromEnv(get: (k: string) => string | undefined): PaymentProvider | null {
  const domain = (get("YAPPY_DOMAIN") ?? "").replace(/\/+$/, "");
  if ((get("PAYMENT_PROVIDER") ?? "yappy") === "mock") {
    const secret = get("MOCK_PAYMENT_SECRET") ?? "";
    return secret && domain ? new YappyMockProvider({ secret, domain }) : null;
  }
  const merchantId = get("YAPPY_MERCHANT_ID") ?? "";
  const secret = get("YAPPY_SECRET_KEY") ?? "";
  if (!merchantId || !secret || !domain) return null;
  return new YappyProvider({
    env: get("YAPPY_ENV") === "produccion" ? "produccion" : "pruebas",
    merchantId,
    secret,
    domain,
    testPhone: get("YAPPY_TEST_PHONE") ?? "",
  });
}
