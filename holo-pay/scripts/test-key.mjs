// Prints a random TEST Yappy secret key with the real format (base64 of "<hmac key>.<rest>").
import { randomBytes } from "node:crypto";
const part = (n) => randomBytes(n).toString("hex");
console.log(Buffer.from(`${part(16)}.${part(8)}`).toString("base64"));
