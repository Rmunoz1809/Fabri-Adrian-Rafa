"use client";

import { useEffect, useState } from "react";
import { formatUsd, STATUS_LABEL } from "@/lib/format";

type OrderStatus = {
  publicId: string;
  status: string;
  listingTitle: string;
  itemCents: number;
  shippingCents: number;
  totalCents: number;
  expiresAt: string;
};

const POLL_MS = 4000;
const PAID = new Set(["paid", "seller_notified", "shipped", "delivered", "payout_released"]);

/**
 * Polls the order status until it leaves pending_payment. The payment is confirmed only by
 * the server (Yappy IPN), never by a browser redirect.
 */
export default function WaitForPayment({ publicId }: { publicId: string }) {
  const [order, setOrder] = useState<OrderStatus | null>(null);
  const [missing, setMissing] = useState(false);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let stop = false;
    let timer: ReturnType<typeof setTimeout>;
    async function poll() {
      try {
        const res = await fetch(`/api/orders/${encodeURIComponent(publicId)}/status`, { cache: "no-store" });
        if (res.status === 404) return setMissing(true);
        if (res.ok) {
          const data: OrderStatus = await res.json();
          if (stop) return;
          setOrder(data);
          if (data.status !== "pending_payment") return;
        }
      } catch {
        // Offline for a moment: keep trying.
      }
      if (!stop) timer = setTimeout(poll, POLL_MS);
    }
    poll();
    const clock = setInterval(() => setNow(Date.now()), 1000);
    return () => {
      stop = true;
      clearTimeout(timer);
      clearInterval(clock);
    };
  }, [publicId]);

  if (missing) return <p className="notice bad">No encontramos esa orden.</p>;
  if (!order) return <div className="spinner" aria-label="Cargando" />;

  const secondsLeft = Math.max(0, Math.floor((new Date(order.expiresAt).getTime() - now) / 1000) - 60);
  const header = (
    <>
      <p className="muted small" style={{ margin: 0 }}>Orden</p>
      <p className="code" style={{ margin: "0 0 12px" }}>{order.publicId}</p>
    </>
  );
  const summary = (
    <dl className="lines">
      <div><dt>{order.listingTitle}</dt><dd>{formatUsd(order.itemCents)}</dd></div>
      <div><dt>Envío</dt><dd>{formatUsd(order.shippingCents)}</dd></div>
      <div className="total"><dt>Total</dt><dd>{formatUsd(order.totalCents)}</dd></div>
    </dl>
  );

  if (order.status === "pending_payment") {
    return (
      <section className="panel center" aria-live="polite">
        <div className="spinner" />
        <h1>Esperando tu pago en Yappy</h1>
        <p className="muted">Abre la app de Yappy y aprueba la solicitud de pago de Holo.</p>
        {header}
        {summary}
        <p className="small muted">
          {secondsLeft > 0
            ? `Te quedan ${Math.floor(secondsLeft / 60)}:${String(secondsLeft % 60).padStart(2, "0")} para pagar.`
            : "Si ya pagaste, espera un momento: estamos confirmando con Yappy."}
        </p>
      </section>
    );
  }

  if (PAID.has(order.status)) {
    return (
      <section className="panel center" aria-live="polite">
        <h1>¡Pago recibido!</h1>
        <p className="notice good">Le avisamos al vendedor. Te escribimos para coordinar la entrega.</p>
        {header}
        {summary}
        <p className="xs muted">Guarda el número de orden para cualquier consulta.</p>
      </section>
    );
  }

  const messages: Record<string, string> = {
    expired: "Se venció el tiempo para pagar. No se cobró nada. Puedes intentarlo de nuevo.",
    cancelled: "El pago se canceló. No se cobró nada.",
    rejected: "Yappy rechazó el pago. No se cobró nada. Revisa tu saldo o inténtalo de nuevo.",
    under_review: "Recibimos un pago que tenemos que revisar. Te escribimos pronto; no tienes que hacer nada.",
    refunded: "Esta orden fue reembolsada.",
  };
  return (
    <section className="panel center" aria-live="polite">
      <h1>{STATUS_LABEL[order.status] ?? order.status}</h1>
      <p className={`notice ${order.status === "under_review" ? "warn" : "bad"}`}>{messages[order.status] ?? ""}</p>
      {header}
      <a className="btn block" href="/">Volver a las cartas</a>
    </section>
  );
}
