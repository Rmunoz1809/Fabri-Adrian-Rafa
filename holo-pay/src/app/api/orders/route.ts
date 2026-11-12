import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { createOrder } from "@/lib/orders/create";
import { RateLimiter } from "@/lib/rate-limit";
import { getYappyClient } from "@/lib/yappy/client";

export const runtime = "nodejs";

// 5 order attempts per minute per IP.
const limiter = new RateLimiter(5, 60_000);

function clientIp(req: NextRequest): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || req.headers.get("x-real-ip") || "unknown";
}

export async function POST(req: NextRequest) {
  if (!limiter.check(clientIp(req))) {
    return NextResponse.json({ error: "Demasiados intentos. Espera un minuto y vuelve a intentar." }, { status: 429 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Datos inválidos." }, { status: 400 });
  }
  const result = await createOrder(prisma, getYappyClient(), body);
  if (!result.ok) return NextResponse.json({ error: result.error, code: result.code }, { status: result.status });
  return NextResponse.json({ order: result.order, yappy: result.yappy }, { status: 201 });
}
