"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export default function CheckoutForm({ listingId }: { listingId: string }) {
  const router = useRouter();
  const [phone, setPhone] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sending, setSending] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    const digits = phone.replace(/\D/g, "").replace(/^507(?=\d{8}$)/, "");
    if (!/^6\d{7}$/.test(digits)) return setError("Escribe tu celular de Yappy: 8 dígitos que empiezan con 6.");
    setSending(true);
    try {
      // Only the listing and the phone: the server sets the amount.
      const res = await fetch("/api/orders", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ listingId, buyerPhone: digits }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error ?? "No pudimos crear la orden. Inténtalo de nuevo.");
        setSending(false);
        return;
      }
      router.push(`/orden/${data.order.publicId}`);
    } catch {
      setError("No hay conexión. Revisa tu internet e inténtalo de nuevo.");
      setSending(false);
    }
  }

  return (
    <form onSubmit={submit} noValidate style={{ display: "grid", gap: 12 }}>
      <label>
        Tu celular de Yappy
        <input type="tel" inputMode="numeric" autoComplete="tel-national" placeholder="6123-4567" maxLength={15} value={phone} onChange={(e) => setPhone(e.target.value)} required />
      </label>
      {error && <p className="notice bad" role="alert" style={{ margin: 0 }}>{error}</p>}
      <button className="btn yappy block" disabled={sending}>{sending ? "Enviando a Yappy…" : "Pagar con Yappy"}</button>
      <p className="xs muted" style={{ margin: 0 }}>Te llega una solicitud de pago en la app de Yappy. Tienes 5 minutos para aprobarla.</p>
    </form>
  );
}
