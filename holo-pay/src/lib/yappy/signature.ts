import { createHmac, timingSafeEqual } from "node:crypto";

/**
 * HMAC key for Yappy IPN signatures: the first dot-separated part of YAPPY_SECRET_KEY
 * after base64-decoding it.
 */
export function ipnSigningKey(secretKey: string): string {
  const decoded = Buffer.from(secretKey, "base64").toString("utf8");
  const key = decoded.split(".")[0];
  if (!key) throw new Error("YAPPY_SECRET_KEY has an unexpected format");
  return key;
}

/** Lowercase hex HMAC-SHA256 of orderId + status + domain. */
export function signIpn(params: { orderId: string; status: string; domain: string }, secretKey: string): string {
  return createHmac("sha256", ipnSigningKey(secretKey))
    .update(params.orderId + params.status + params.domain)
    .digest("hex");
}

/** Constant-time check of the IPN `hash`. Never throws on bad input; returns false. */
export function verifyIpnSignature(
  params: { orderId: string; status: string; domain: string; hash: string },
  secretKey: string,
): boolean {
  let expected: Buffer;
  try {
    expected = Buffer.from(signIpn(params, secretKey), "utf8");
  } catch {
    return false;
  }
  const received = Buffer.from(params.hash.trim().toLowerCase(), "utf8");
  if (received.length !== expected.length) return false;
  return timingSafeEqual(received, expected);
}
