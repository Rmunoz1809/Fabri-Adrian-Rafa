/** Constant-time string comparison without node:crypto (works in any runtime). */
function safeEqual(a: string, b: string): boolean {
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i++) diff |= (a.charCodeAt(i) || 0) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
}

/** Checks an `Authorization: Basic …` header against ADMIN_USER / ADMIN_PASSWORD. */
export function checkBasicAuth(header: string | null, user: string | undefined, password: string | undefined): boolean {
  if (!user || !password || password.length < 12) return false; // not configured → locked
  if (!header?.startsWith("Basic ")) return false;
  let decoded: string;
  try {
    decoded = atob(header.slice(6).trim());
  } catch {
    return false;
  }
  const i = decoded.indexOf(":");
  if (i < 0) return false;
  return safeEqual(decoded.slice(0, i), user) && safeEqual(decoded.slice(i + 1), password);
}
