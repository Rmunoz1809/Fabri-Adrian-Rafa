// Yappy Botón de Pago V2 (Banco General). Same flow as the original yappy-pago function:
// validate/merchant → token, then payment-wc → { transactionId, token, documentName } for the
// <btn-yappy> web component. Docs:
// https://www.yappy.com.pa/comercial/desarrolladores/boton-de-pago-yappy-nueva-integracion/
import {
  ProviderError,
  money,
  type ChargeRequest,
  type ChargeSession,
  type ChargeState,
  type PaymentProvider,
  type ProviderNotification,
  type VerifiedNotification,
} from "./provider.ts";
import { verifyYappyNotification } from "./yappy-hash.ts";

const API = {
  pruebas: "https://api-comecom-uat.yappycloud.com",
  produccion: "https://apipagosbg.bgeneral.cloud",
} as const;

// Yappy's error codes, in words a buyer understands.
const YAPPY_ERRORS: Record<string, string> = {
  E005: "Ese número no está registrado en Yappy.",
  E007: "Este pago ya se había iniciado. Intenta de nuevo.",
  E010: "El monto no coincide. Recarga la página e intenta de nuevo.",
};

export interface YappyConfig {
  env: "pruebas" | "produccion";
  merchantId: string;
  secret: string;
  domain: string;
  /** Only in pruebas: the phone registered in Yappy's test program (aliasYappy). */
  testPhone?: string;
  fetch?: typeof fetch;
}

export class YappyProvider implements PaymentProvider {
  readonly name = "yappy" as const;

  constructor(private readonly cfg: YappyConfig) {}

  private async post(url: string, body: unknown, token?: string) {
    const res = await (this.cfg.fetch ?? fetch)(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...(token ? { Authorization: token } : {}) },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(15000),
    });
    const data = await res.json().catch(() => null);
    return { ok: res.ok, data };
  }

  async createCharge(req: ChargeRequest): Promise<ChargeSession> {
    const api = API[this.cfg.env];
    const v = await this.post(`${api}/payments/validate/merchant`, { merchantId: this.cfg.merchantId, urlDomain: this.cfg.domain });
    const token = v.data?.body?.token;
    if (!v.ok || !token) throw new ProviderError("Yappy no está disponible en este momento. Intenta en un rato.", "validate");
    const order = {
      merchantId: this.cfg.merchantId,
      orderId: req.orderId,
      domain: this.cfg.domain,
      // TODO(yappy real): confirm in the test environment that paymentDate takes Yappy's epochTime.
      paymentDate: v.data?.body?.epochTime ?? Math.floor(Date.now() / 1000),
      ...(this.cfg.env === "pruebas" && this.cfg.testPhone ? { aliasYappy: this.cfg.testPhone } : {}),
      ipnUrl: req.ipnUrl,
      discount: "0.00",
      taxes: money(req.taxesCents),
      subtotal: money(req.subtotalCents),
      total: money(req.totalCents),
    };
    const c = await this.post(`${api}/payments/payment-wc`, order, token);
    const b = c.data?.body;
    if (!c.ok || !b?.transactionId || !b?.token || !b?.documentName) {
      const code = String(c.data?.status?.code ?? "");
      throw new ProviderError(YAPPY_ERRORS[code] ?? "No pudimos iniciar el pago con Yappy. Intenta de nuevo.", code);
    }
    return { transactionId: b.transactionId, token: b.token, documentName: b.documentName };
  }

  verifyNotification(n: ProviderNotification): Promise<VerifiedNotification> {
    return verifyYappyNotification(this.cfg.secret, this.cfg.domain, n);
  }

  // TODO(yappy real): the V2 button documents no status query; until Banco General gives one,
  // the IPN is the only source of truth and this answers "unknown".
  async getStatus(): Promise<ChargeState> {
    return "unknown";
  }
}
