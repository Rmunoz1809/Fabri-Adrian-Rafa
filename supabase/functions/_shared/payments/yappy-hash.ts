// Yappy Botón de Pago V2 notification signature:
//   key  = first part (before the first ".") of the base64-decoded secret key
//   hash = hex(HMAC-SHA256(key, orderId + status + domain))
// The comparison is constant-time and the domain must be Holo's own.
import {
  PROVIDER_STATUSES,
  isValidOrderId,
  type ProviderNotification,
  type ProviderStatus,
  type VerifiedNotification,
} from "./provider.ts";

function hmacKeyFromSecret(secretB64: string): string | null {
  try {
    const decoded = new TextDecoder().decode(Uint8Array.from(atob(secretB64.trim()), (c) => c.charCodeAt(0)));
    const key = decoded.split(".")[0];
    return key || null;
  } catch {
    return null;
  }
}

async function hmacSha256Hex(key: string, data: string): Promise<string> {
  const k = await crypto.subtle.importKey("raw", new TextEncoder().encode(key), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", k, new TextEncoder().encode(data)));
  return [...sig].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Constant-time string comparison (length is not secret: it is always 64 hex chars). */
export function timingSafeEqual(a: string, b: string): boolean {
  const len = Math.max(a.length, b.length);
  let diff = a.length ^ b.length;
  for (let i = 0; i < len; i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

export const normalizeDomain = (d: string) => d.trim().replace(/\/+$/, "").toLowerCase();

/** The hash Yappy would send for this notification. Used by the mock and by the tests. */
export async function signYappyNotification(secretB64: string, orderId: string, status: string, domain: string): Promise<string> {
  const key = hmacKeyFromSecret(secretB64);
  if (!key) throw new Error("invalid secret key");
  return hmacSha256Hex(key, orderId + status + domain);
}

export async function verifyYappyNotification(
  secretB64: string,
  expectedDomain: string,
  n: ProviderNotification,
): Promise<VerifiedNotification> {
  if (!n.orderId || !n.status || !n.hash || !n.domain) return { valid: false, reason: "missing parameters" };
  const key = hmacKeyFromSecret(secretB64);
  if (!key) return { valid: false, reason: "bad hash" };
  const expected = await hmacSha256Hex(key, n.orderId + n.status + n.domain);
  if (!timingSafeEqual(n.hash.toLowerCase(), expected)) return { valid: false, reason: "bad hash" };
  // The hash covers the domain, but a valid hash for another merchant domain must still be refused.
  if (normalizeDomain(n.domain) !== normalizeDomain(expectedDomain)) return { valid: false, reason: "wrong domain" };
  if (!isValidOrderId(n.orderId)) return { valid: false, reason: "bad order id" };
  if (!PROVIDER_STATUSES.includes(n.status as ProviderStatus)) return { valid: false, reason: "unknown status" };
  return {
    valid: true,
    orderId: n.orderId,
    status: n.status as ProviderStatus,
    domain: n.domain,
    confirmationNumber: n.confirmationNumber ?? null,
  };
}
