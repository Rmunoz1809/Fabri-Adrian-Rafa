// Local test data: two sellers and a few listings. Usage: npm run db:seed
import { PrismaClient } from "@prisma/client";

const db = new PrismaClient();
const store = await db.seller.create({ data: { name: "Tienda Demo", kind: "store", verified: true } });
const person = await db.seller.create({ data: { name: "Diego M.", kind: "person", verified: false } });
const listings = [
  { title: "Koraidon ex 247/198 · Scarlet & Violet · PSA 10", priceCents: 10500, stock: 1, sellerId: store.id },
  { title: "Charizard ex 199/165 · 151 · Raw NM", priceCents: 24000, stock: 1, sellerId: store.id },
  { title: "Booster Box Prismatic Evolutions (sellado)", priceCents: 18500, stock: 3, sellerId: store.id },
  { title: "Victor Wembanyama 2023 Prizm RC #136", priceCents: 4500, stock: 1, sellerId: person.id },
];
for (const l of listings) await db.listing.create({ data: l });
console.log(`Seeded ${listings.length} listings.`);
await db.$disconnect();
