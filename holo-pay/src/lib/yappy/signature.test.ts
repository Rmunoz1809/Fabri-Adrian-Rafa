import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_SECRET } from "@/test/keys";
import { ipnSigningKey, signIpn, verifyIpnSignature } from "./signature";

const base = { orderId: "HABC123XYZ", status: "E", domain: "https://holo.test" };

describe("IPN signature", () => {
  it("uses the first dot-separated part of the base64-decoded secret as the key", () => {
    expect(ipnSigningKey(TEST_SECRET)).toBe("test-hmac-key");
  });

  it("is lowercase hex HMAC-SHA256 of orderId + status + domain", () => {
    const expected = createHmac("sha256", "test-hmac-key").update("HABC123XYZEhttps://holo.test").digest("hex");
    expect(signIpn(base, TEST_SECRET)).toBe(expected);
    expect(expected).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts a correct signature", () => {
    expect(verifyIpnSignature({ ...base, hash: signIpn(base, TEST_SECRET) }, TEST_SECRET)).toBe(true);
  });

  it("accepts uppercase hex too", () => {
    expect(verifyIpnSignature({ ...base, hash: signIpn(base, TEST_SECRET).toUpperCase() }, TEST_SECRET)).toBe(true);
  });

  it("rejects a wrong signature", () => {
    expect(verifyIpnSignature({ ...base, hash: "0".repeat(64) }, TEST_SECRET)).toBe(false);
    expect(verifyIpnSignature({ ...base, hash: "" }, TEST_SECRET)).toBe(false);
    expect(verifyIpnSignature({ ...base, hash: "not-hex" }, TEST_SECRET)).toBe(false);
  });

  it("rejects a signature made with another key", () => {
    const other = Buffer.from("other-key.x").toString("base64");
    expect(verifyIpnSignature({ ...base, hash: signIpn(base, other) }, TEST_SECRET)).toBe(false);
  });

  it("rejects when orderId, status or domain were altered", () => {
    const hash = signIpn(base, TEST_SECRET);
    expect(verifyIpnSignature({ ...base, orderId: "HABC123XYY", hash }, TEST_SECRET)).toBe(false);
    expect(verifyIpnSignature({ ...base, status: "R", hash }, TEST_SECRET)).toBe(false);
    expect(verifyIpnSignature({ ...base, domain: "https://evil.test", hash }, TEST_SECRET)).toBe(false);
  });
});
