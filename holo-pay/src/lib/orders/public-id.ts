import { randomInt } from "node:crypto";

const ALPHABET = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Characters after the "H" prefix. 36^9 ≈ 1e14 combinations. */
export const PUBLIC_ID_RANDOM_LENGTH = 9;
/** Yappy orderId rule: alphanumeric, 1 to 15 characters. */
export const YAPPY_ORDER_ID = /^[A-Za-z0-9]{1,15}$/;

/** Short order number sent to Yappy as orderId and shown to the buyer, e.g. "H7K2Q9ZP4M". */
export function generatePublicId(): string {
  let id = "H";
  for (let i = 0; i < PUBLIC_ID_RANDOM_LENGTH; i++) id += ALPHABET[randomInt(ALPHABET.length)];
  return id;
}
