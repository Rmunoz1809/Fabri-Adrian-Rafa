/**
 * Where to send the user after signing in: only a path on this site. Anything that could leave the
 * site ("//evil.com", "/\evil.com", "https://…", tabs or other control characters) falls back to "/".
 */
export function safeNext(value: unknown): string {
  const s = typeof value === "string" ? value : "";
  if (!s.startsWith("/") || s.includes("\\") || [...s].some((ch) => ch.charCodeAt(0) < 32)) return "/";
  try {
    const url = new URL(s, "http://holo.local");
    if (url.origin !== "http://holo.local") return "/";
    return `${url.pathname}${url.search}${url.hash}`;
  } catch {
    return "/";
  }
}
