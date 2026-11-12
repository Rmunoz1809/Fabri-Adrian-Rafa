import { NextResponse, type NextRequest } from "next/server";
import { paidOrdersCsv, panamaToday } from "@/lib/admin/export";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** CSV of the orders paid on a Panama day (?date=YYYY-MM-DD, default today). */
export async function GET(req: NextRequest) {
  const date = req.nextUrl.searchParams.get("date") || panamaToday();
  let result;
  try {
    result = await paidOrdersCsv(prisma, date);
  } catch {
    return NextResponse.json({ error: "Fecha inválida (usa AAAA-MM-DD)." }, { status: 400 });
  }
  return new NextResponse("﻿" + result.csv, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="holo-pagadas-${date}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}
