import { centsToDollars } from "@/lib/money";
import { isYappyMock, readYappyConfig, type YappyConfig } from "./config";
import { yappyErrorMessage } from "./errors";

export type CreatePaymentInput = {
  /** Order publicId: alphanumeric, 1-15 chars. */
  orderId: string;
  /** 8-digit Panamanian mobile, no prefix. */
  aliasYappy: string;
  subtotalCents: number;
  taxesCents: number;
  discountCents: number;
  totalCents: number;
};

export type CreatePaymentResult =
  | { ok: true; transactionId: string; token: string; documentName: string }
  | { ok: false; code: string; message: string };

/** Same interface for the real client and the mock. */
export interface YappyClient {
  createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult>;
}

type YappyResponse = { status?: { code?: string; description?: string }; body?: Record<string, unknown> | null };

const TIMEOUT_MS = 15_000;

/** Real client for Yappy's "Botón de Pago" API. All calls are server-side. */
export class HttpYappyClient implements YappyClient {
  constructor(
    private readonly config: YappyConfig,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  private async post(path: string, body: unknown, headers: Record<string, string> = {}): Promise<YappyResponse> {
    const res = await this.fetchImpl(`${this.config.baseUrl}${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    let json: YappyResponse = {};
    try {
      json = (await res.json()) as YappyResponse;
    } catch {
      // Non-JSON error page.
    }
    if (!res.ok && !json.status?.code) json.status = { code: `HTTP${res.status}` };
    return json;
  }

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    try {
      const auth = await this.post("/payments/validate/merchant", {
        merchantId: this.config.merchantId,
        urlDomain: this.config.domain,
      });
      const token = auth.body?.token;
      const epochTime = auth.body?.epochTime;
      if (typeof token !== "string" || epochTime === undefined) return failure(auth.status?.code);

      const pay = await this.post(
        "/payments/payment-wc",
        {
          merchantId: this.config.merchantId,
          orderId: input.orderId,
          domain: this.config.domain,
          paymentDate: Number(epochTime),
          aliasYappy: input.aliasYappy,
          ipnUrl: this.config.ipnUrl,
          discount: centsToDollars(input.discountCents),
          taxes: centsToDollars(input.taxesCents),
          subtotal: centsToDollars(input.subtotalCents),
          total: centsToDollars(input.totalCents),
        },
        { Authorization: token },
      );
      const b = pay.body;
      if (b && typeof b.transactionId === "string" && typeof b.token === "string" && typeof b.documentName === "string") {
        return { ok: true, transactionId: b.transactionId, token: b.token, documentName: b.documentName };
      }
      return failure(pay.status?.code);
    } catch (e) {
      // Network error or timeout. Log the kind only (no tokens, no keys).
      console.error("[yappy] createPayment failed:", e instanceof Error ? e.name : "unknown");
      return failure("NETWORK");
    }
  }
}

function failure(code: string | undefined): CreatePaymentResult {
  const c = code ?? "UNKNOWN";
  console.warn(`[yappy] payment-wc error ${c}`);
  return { ok: false, code: c, message: yappyErrorMessage(c) };
}

/**
 * In-memory mock with the same interface, for local development (YAPPY_MODE=mock) and tests.
 * Special phones reproduce Yappy errors: 60000005 → E005, 60000010 → E010.
 */
export class MockYappyClient implements YappyClient {
  readonly calls: CreatePaymentInput[] = [];
  private readonly seen = new Set<string>();

  async createPayment(input: CreatePaymentInput): Promise<CreatePaymentResult> {
    this.calls.push(input);
    if (!/^[A-Za-z0-9]{1,15}$/.test(input.orderId)) return failure("E009");
    if (this.seen.has(input.orderId)) return failure("E007");
    if (input.aliasYappy === "60000005") return failure("E005");
    if (input.aliasYappy === "60000010" || input.totalCents < 1 || input.totalCents !== input.subtotalCents + input.taxesCents - input.discountCents)
      return failure("E010");
    this.seen.add(input.orderId);
    return { ok: true, transactionId: `MOCK-${input.orderId}`, token: "mock-token", documentName: `mock-${input.orderId}` };
  }
}

let shared: YappyClient | undefined;

/** The configured client: the mock when YAPPY_MODE=mock, otherwise the real API. */
export function getYappyClient(): YappyClient {
  if (!shared) shared = isYappyMock() ? new MockYappyClient() : new HttpYappyClient(readYappyConfig());
  return shared;
}
