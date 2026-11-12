import { copyFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PrismaClient } from "@prisma/client";

export const TEMPLATE_DB = join(tmpdir(), "holo-pay-test-template.db");

/** A fresh, isolated SQLite database with the current schema. Call `cleanup` in afterAll. */
export function createTestDb() {
  const dir = mkdtempSync(join(tmpdir(), "holo-pay-"));
  const file = join(dir, "test.db");
  copyFileSync(TEMPLATE_DB, file);
  const db = new PrismaClient({ datasources: { db: { url: `file:${file}` } } });
  return {
    db,
    cleanup: async () => {
      await db.$disconnect();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

/** A seller and an active listing with `stock` units. */
export async function seedListing(db: PrismaClient, opts: { priceCents?: number; stock?: number } = {}) {
  const seller = await db.seller.create({ data: { name: "Tienda Test", kind: "store", verified: true } });
  return db.listing.create({
    data: { title: "Koraidon ex 247/198 PSA 10", priceCents: opts.priceCents ?? 10500, stock: opts.stock ?? 1, sellerId: seller.id },
  });
}

let seq = 0;
/** A pending order that already holds one unit (the listing's stock is decremented accordingly). */
export async function seedPendingOrder(db: PrismaClient, listingId: string, opts: { expiresAt?: Date } = {}) {
  const listing = await db.listing.update({ where: { id: listingId }, data: { stock: { decrement: 1 } } });
  seq += 1;
  return db.order.create({
    data: {
      publicId: `HTEST${seq}`,
      listingId,
      buyerPhone: "61234567",
      itemCents: listing.priceCents,
      shippingCents: 300,
      subtotalCents: listing.priceCents + 300,
      taxesCents: 0,
      totalCents: listing.priceCents + 300,
      expiresAt: opts.expiresAt ?? new Date(Date.now() + 6 * 60_000),
    },
  });
}
