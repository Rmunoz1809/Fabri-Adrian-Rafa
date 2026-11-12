/** Test-only Yappy secret with the real shape: base64("<hmac key>.<rest>"). Not a real credential. */
export const TEST_SECRET = Buffer.from("test-hmac-key.second-part.third").toString("base64");
export const TEST_DOMAIN = "https://holo.test";
