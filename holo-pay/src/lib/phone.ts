/**
 * Yappy alias: a Panamanian mobile number without prefix (8 digits, starting with 6).
 * Accepts common ways people type it ("6123-4567", "+507 6123 4567") and returns "61234567",
 * or null if it isn't a valid mobile.
 */
export function normalizePanamaMobile(input: string): string | null {
  let digits = input.replace(/[\s\-().]/g, "");
  if (digits.startsWith("+")) digits = digits.slice(1);
  if (digits.startsWith("00507")) digits = digits.slice(5);
  else if (digits.length === 11 && digits.startsWith("507")) digits = digits.slice(3);
  return /^6\d{7}$/.test(digits) ? digits : null;
}
