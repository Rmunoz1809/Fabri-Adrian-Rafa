/**
 * Runs the expiry job every minute inside a long-running Node server (`next start`, `next dev`).
 * On serverless hosts set EXPIRY_INTERVAL=off and call /api/cron/expire from the platform's cron.
 */
export async function register() {
  if (process.env.NEXT_RUNTIME !== "nodejs" || process.env.EXPIRY_INTERVAL === "off") return;
  const { prisma } = await import("./lib/db");
  const { expireOrders } = await import("./lib/orders/expire");
  const tick = () => expireOrders(prisma).catch((e) => console.error("[expire] failed:", e instanceof Error ? e.message : e));
  setInterval(tick, 60_000).unref();
}
