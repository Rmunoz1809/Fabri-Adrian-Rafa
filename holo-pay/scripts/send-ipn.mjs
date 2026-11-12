// Sends a signed Yappy IPN to the local app, to test the flow without the real Yappy.
// Usage: npm run ipn -- <publicId> <E|R|C|X> [--bad-signature] [--url http://localhost:3000]
// Uses YAPPY_SECRET_KEY and YAPPY_DOMAIN from the environment (.env). Use a TEST key only.
import { createHmac } from "node:crypto";

const args = process.argv.slice(2);
const [orderId, status] = args.filter((a) => !a.startsWith("--") && !/^https?:/.test(a));
const urlIdx = args.indexOf("--url");
const base = urlIdx >= 0 ? args[urlIdx + 1] : process.env.APP_BASE_URL || "http://localhost:3000";
if (!orderId || !/^[ERCX]$/.test(status ?? "")) {
  console.error("Usage: npm run ipn -- <publicId> <E|R|C|X> [--bad-signature] [--url http://localhost:3000]");
  process.exit(1);
}
const secret = process.env.YAPPY_SECRET_KEY;
const domain = process.env.YAPPY_DOMAIN || "http://localhost:3000";
if (!secret) {
  console.error("Set YAPPY_SECRET_KEY (run `npm run yappy:test-key` to make a test one).");
  process.exit(1);
}
const key = Buffer.from(secret, "base64").toString("utf8").split(".")[0];
let hash = createHmac("sha256", key).update(orderId + status + domain).digest("hex");
if (args.includes("--bad-signature")) hash = hash.replace(/^./, (c) => (c === "0" ? "1" : "0"));

const url = new URL("/api/yappy/ipn", base);
url.search = new URLSearchParams({ orderId, status, hash, domain, confirmationNumber: `TEST${Date.now()}` }).toString();
const res = await fetch(url);
console.log(`IPN ${status} for ${orderId} → HTTP ${res.status}`, await res.text());
