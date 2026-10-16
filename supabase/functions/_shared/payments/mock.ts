// Mock of the Yappy Botón de Pago V2, for development and tests. It behaves like Yappy where it
// matters to Holo: 15-character alphanumeric order ids, notifications by GET with orderId, status,
// hash and domain, statuses E/R/C/X, and the same HMAC signature (with MOCK_PAYMENT_SECRET instead
// of Yappy's secret). No money moves. simulate() builds the notification Yappy would send.
import {
  ProviderError,
  isValidOrderId,
  type ChargeRequest,
  type ChargeSession,
  type ChargeState,
  type PaymentProvider,
  type ProviderNotification,
  type ProviderStatus,
  type VerifiedNotification,
} from "./provider.ts";
import { signYappyNotification, verifyYappyNotification } from "./yappy-hash.ts";

export interface MockConfig {
  /** Base64 secret in Yappy's format ("<hmac key>.<anything>" encoded). From MOCK_PAYMENT_SECRET. */
  secret: string;
  /** Holo's domain, as configured in the payment button. */
  domain: string;
  /** Reads the attempt's status from the database (getStatus). */
  lookup?: (orderId: string) => Promise<ChargeState>;
}

export class YappyMockProvider implements PaymentProvider {
  readonly name = "mock" as const;
  private readonly charges = new Map<string, ChargeRequest>();

  constructor(private readonly cfg: MockConfig) {
    if (!cfg.secret || !cfg.domain) throw new Error("mock provider needs a secret and a domain");
  }

  async createCharge(req: ChargeRequest): Promise<ChargeSession> {
    if (!isValidOrderId(req.orderId)) throw new ProviderError("orderId must be 1-15 letters or digits", "E002");
    if (req.subtotalCents + req.taxesCents !== req.totalCents) throw new ProviderError("El monto no coincide.", "E010");
    if (this.charges.has(req.orderId)) throw new ProviderError("Este pago ya se había iniciado.", "E007");
    this.charges.set(req.orderId, req);
    return { transactionId: `MOCK${req.orderId}`, token: "mock-token", documentName: "mock", simulated: true };
  }

  verifyNotification(n: ProviderNotification): Promise<VerifiedNotification> {
    return verifyYappyNotification(this.cfg.secret, this.cfg.domain, n);
  }

  async getStatus(orderId: string): Promise<ChargeState> {
    return this.cfg.lookup ? this.cfg.lookup(orderId) : this.charges.has(orderId) ? "pending" : "unknown";
  }

  /** The notification Yappy would send for this attempt and status (development simulator). */
  async simulate(orderId: string, status: ProviderStatus): Promise<ProviderNotification> {
    const hash = await signYappyNotification(this.cfg.secret, orderId, status, this.cfg.domain);
    return {
      orderId,
      status,
      hash,
      domain: this.cfg.domain,
      confirmationNumber: status === "E" ? `MOCK-${Date.now().toString(36).toUpperCase()}` : null,
    };
  }
}
