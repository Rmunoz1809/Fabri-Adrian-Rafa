import { NextResponse, type NextRequest } from "next/server";
import { resolveEvent } from "@/lib/admin/review";
import { prisma } from "@/lib/db";

export const runtime = "nodejs";

export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  await resolveEvent(prisma, id, String(form.get("note") ?? "").trim());
  return NextResponse.redirect(new URL("/admin/revision", req.url), 303);
}
