// Supabase Edge Function: payments for Compra Protegida (migration 0029). The provider sits behind
// the PaymentProvider interface (../_shared/payments): the Yappy Botón de Pago V2, or a mock of it
// for development. The HTTP logic lives in _shared/payments/handler.ts (tested in Node):
//   POST  (holo.html, with the buyer's session) { order_id }
//         → new_payment_attempt() checks the order and returns the amounts, then the provider
//           creates the charge. Returns { transactionId, token, documentName, attempt, simulated? }.
//   GET   (the provider's IPN) ?orderId&status&hash&domain&confirmationNumber
//         → hash (HMAC-SHA256) and domain checked here, then process_payment_notification() with the
//           service role logs it and processes it once (a repeated notice is a no-op).
//   POST  ?simular { attempt_id, status }  → development only: E/R/C/X with the mock.
// The amounts always come from the database, never from the browser.
//
// Secrets (Supabase ▸ Edge Functions ▸ Secrets, never in the page or the repo):
//   PAYMENT_PROVIDER    "yappy" (default) or "mock"
//   YAPPY_DOMAIN        Domain set in the payment button, e.g. https://rmunoz1809.github.io (both providers)
//   YAPPY_MERCHANT_ID   ID del comercio (Yappy Comercial ▸ Botón de pago)
//   YAPPY_SECRET_KEY    Clave secreta generada al crear el botón (base64)
//   YAPPY_ENV           "pruebas" (default) or "produccion"
//   YAPPY_TEST_PHONE    Only in pruebas: the phone registered in Yappy's test program (aliasYappy)
//   MOCK_PAYMENT_SECRET Mock only: base64 of "<key>.<anything>", like Yappy's secret
//   PAYMENT_DEV_SIMULATOR "true" to allow ?simular (mock only; never in production)
// Deploy (after migration 0029):
//   supabase functions deploy yappy-pago --no-verify-jwt --use-api --project-ref vqcpqoedsyatxswdzqcy
// (--no-verify-jwt because the IPN has no session; the POST checks the session itself.)
import { createClient } from "npm:@supabase/supabase-js@2";
import { createPaymentHandler, providerFromEnv } from "../_shared/payments/handler.ts";

const env = (k: string) => Deno.env.get(k);
const provider = providerFromEnv(env);
const url = env("SUPABASE_URL")!;

const handler = provider &&
  createPaymentHandler({
    provider,
    ipnUrl: `${url}/functions/v1/yappy-pago`,
    devSimulator: provider.name === "mock" && env("PAYMENT_DEV_SIMULATOR") === "true",
    rpcAsUser: async (authorization, fn, args) => {
      const sb = createClient(url, env("SUPABASE_ANON_KEY") ?? "", {
        global: { headers: { Authorization: authorization } },
        auth: { persistSession: false },
      });
      return await sb.rpc(fn, args);
    },
    rpcAsService: async (fn, args) => {
      const sb = createClient(url, env("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
      return await sb.rpc(fn, args);
    },
  });

Deno.serve((req) =>
  handler
    ? handler(req)
    : new Response(JSON.stringify({ error: "El pago todavía no está configurado." }), {
      status: 503,
      headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" },
    })
);
