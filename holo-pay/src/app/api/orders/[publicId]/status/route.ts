import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { expireIfDue } from "@/lib/orders/expire";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Polled by the waiting screen. Public data only (no phone, no Yappy references). */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  if (!/^[A-Za-z0-9]{1,15}$/.test(publicId)) return NextResponse.json({ error: "not_found" }, { status: 404 });
  let order = await prisma.order.findUnique({ where: { publicId }, include: { listing: { select: { title: true } } } });
  if (!order) return NextResponse.json({ error: "not_found" }, { status: 404 });
  if (await expireIfDue(prisma, order)) {
    order = await prisma.order.findUniqueOrThrow({ where: { publicId }, include: { listing: { select: { title: true } } } });
  }
  return NextResponse.json(
    {
      publicId: order.publicId,
      status: order.status,
      listingTitle: order.listing.title,
      itemCents: order.itemCents,
      shippingCents: order.shippingCents,
      totalCents: order.totalCents,
      expiresAt: order.expiresAt.toISOString(),
      paidAt: order.paidAt?.toISOString() ?? null,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
