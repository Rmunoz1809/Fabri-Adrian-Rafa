// The payment provider behind Holo's checkout. The database decides amounts and order state
// (migration 0029); a provider only creates the charge, verifies the provider's notification and
// answers "what happened to this charge". Swapping the mock for the real Yappy button is a matter
// of PAYMENT_PROVIDER=yappy plus its secrets: nothing else changes.
// Plain TypeScript with web APIs only (fetch, crypto.subtle, atob): runs in Deno (Edge Function)
// and in Node (vitest, the local demo).

/** Yappy's statuses: E executed, R rejected (not confirmed within 5 minutes), C cancelled, X expired. */
export type ProviderStatus = "E" | "R" | "C" | "X";
export const PROVIDER_STATUSES: readonly ProviderStatus[] = ["E", "R", "C", "X"];

export interface ChargeRequest {
  /** Holo's payment attempt id: alphanumeric, at most 15 characters, unique per charge. */
  orderId: string;
  subtotalCents: number;
  taxesCents: number;
  totalCents: number;
  /** Where the provider sends its notification (IPN). */
  ipnUrl: string;
}

/** What the page needs to show the payment button (Yappy's <btn-yappy> web component). */
export interface ChargeSession {
  transactionId: string;
  token: string;
  documentName: string;
  /** True for the mock: the page shows the simulator instead of the Yappy button. */
  simulated?: boolean;
}

/** A notification as received: Yappy sends it by GET with orderId, status, hash and domain. */
export interface ProviderNotification {
  orderId: string;
  status: string;
  hash: string;
  domain: string;
  confirmationNumber?: string | null;
}

export type VerifiedNotification =
  | { valid: true; orderId: string; status: ProviderStatus; domain: string; confirmationNumber: string | null }
  | { valid: false; reason: "missing parameters" | "bad hash" | "wrong domain" | "unknown status" | "bad order id" };

export type ChargeState = ProviderStatus | "pending" | "unknown";

export interface PaymentProvider {
  readonly name: "yappy" | "mock";
  createCharge(req: ChargeRequest): Promise<ChargeSession>;
  verifyNotification(n: ProviderNotification): Promise<VerifiedNotification>;
  getStatus(orderId: string): Promise<ChargeState>;
}

export class ProviderError extends Error {
  constructor(message: string, readonly code?: string) {
    super(message);
  }
}

/** Yappy's order id rule: letters and digits only, 1–15 characters. */
export const isValidOrderId = (id: string) => /^[A-Za-z0-9]{1,15}$/.test(id);

export const money = (cents: number) => (cents / 100).toFixed(2);

export function readNotification(params: URLSearchParams): ProviderNotification {
  return {
    orderId: params.get("orderId") ?? "",
    status: params.get("status") ?? "",
    hash: params.get("hash") ?? params.get("Hash") ?? "",
    domain: params.get("domain") ?? "",
    confirmationNumber: params.get("confirmationNumber"),
  };
}
