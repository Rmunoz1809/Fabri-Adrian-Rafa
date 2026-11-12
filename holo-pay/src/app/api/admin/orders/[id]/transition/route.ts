import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { canTransition, isOrderStatus } from "@/lib/orders/state-machine";
import { transitionOrder } from "@/lib/orders/transition";

export const runtime = "nodejs";

/** Staff moves an order one allowed step (form POST from the admin panel). Protected by proxy.ts. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const form = await req.formData();
  const from = String(form.get("from") ?? "");
  const to = String(form.get("to") ?? "");
  const backRaw = String(form.get("back") ?? "/admin");
  const back = backRaw.startsWith("/admin") ? backRaw : "/admin";
  if (!isOrderStatus(from) || !isOrderStatus(to) || !canTransition(from, to)) {
    return NextResponse.json({ error: "Cambio de estado no permitido." }, { status: 400 });
  }
  const r = await transitionOrder(prisma, { orderId: id, from, to, reason: "admin" });
  if (!r.ok) {
    const msg = r.error === "no_stock" ? "No hay stock para reactivar esta orden." : r.error === "stale" ? "La orden cambió mientras tanto. Recarga la página." : "Orden no encontrada.";
    return NextResponse.json({ error: msg }, { status: 409 });
  }
  return NextResponse.redirect(new URL(back, req.url), 303);
}
