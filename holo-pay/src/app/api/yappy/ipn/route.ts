import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { logSellerNotifier } from "@/lib/notify/seller";
import { handleIpn } from "@/lib/yappy/ipn";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** Yappy IPN: GET /api/yappy/ipn?orderId&status&hash&domain[&confirmationNumber]. */
export async function GET(req: NextRequest) {
  const secretKey = process.env.YAPPY_SECRET_KEY;
  const query = Object.fromEntries(req.nextUrl.searchParams.entries());
  if (!secretKey) {
    console.error("[ipn] YAPPY_SECRET_KEY is not set");
    return NextResponse.json({ success: false }, { status: 500 });
  }
  await handleIpn(prisma, query, { secretKey, notifier: logSellerNotifier });
  // Always 200 once stored, so an invalid or duplicate IPN is not retried forever.
  return NextResponse.json({ success: true });
}
