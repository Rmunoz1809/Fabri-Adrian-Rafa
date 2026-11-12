import type { PrismaClient } from "@prisma/client";
import { centsToDollars } from "@/lib/money";
import { toCsv } from "./csv";

/** Panama is UTC-5 all year (no daylight saving). */
const PANAMA_OFFSET_MS = 5 * 60 * 60 * 1000;

/** [start, end) in UTC of a calendar day in Panama, from "YYYY-MM-DD". */
export function panamaDayRange(date: string): { start: Date; end: Date } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!m) throw new RangeError("date must be YYYY-MM-DD");
  const start = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])) + PANAMA_OFFSET_MS);
  if (Number.isNaN(start.getTime()) || start.toISOString().slice(0, 10) !== date) throw new RangeError("invalid date");
  return { start, end: new Date(start.getTime() + 24 * 60 * 60 * 1000) };
}

/** Today's date in Panama as YYYY-MM-DD. */
export function panamaToday(now: Date = new Date()): string {
  return new Date(now.getTime() - PANAMA_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * Orders paid on a Panama calendar day, for the daily reconciliation against Yappy Comercial.
 * Includes orders paid that day that later moved on (shipped, refunded, under review…).
 */
export async function paidOrdersCsv(db: PrismaClient, date: string): Promise<{ csv: string; count: number; totalCents: number }> {
  const { start, end } = panamaDayRange(date);
  const orders = await db.order.findMany({
    where: { paidAt: { gte: start, lt: end } },
    include: { listing: { include: { seller: true } } },
    orderBy: { paidAt: "asc" },
  });
  const rows = orders.map((o) => [
    o.publicId,
    new Date(o.paidAt!.getTime() - PANAMA_OFFSET_MS).toISOString().replace("T", " ").slice(0, 19),
    centsToDollars(o.itemCents),
    centsToDollars(o.shippingCents),
    centsToDollars(o.taxesCents),
    centsToDollars(o.totalCents),
    o.status,
    o.yappyConfirmationNumber ?? "",
    o.yappyTransactionId ?? "",
    o.buyerPhone,
    o.listing.title,
    o.listing.seller.name,
  ]);
  const totalCents = orders.reduce((s, o) => s + o.totalCents, 0);
  const csv = toCsv(
    ["orden", "pagada_panama", "precio", "envio", "impuestos", "total", "estado", "confirmacion_yappy", "transaccion_yappy", "celular", "carta", "vendedor"],
    rows,
  );
  return { csv, count: orders.length, totalCents };
}
