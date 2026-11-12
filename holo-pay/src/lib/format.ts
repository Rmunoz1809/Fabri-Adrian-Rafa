/** "$108.00" for display. */
export function formatUsd(cents: number): string {
  return new Intl.NumberFormat("es-PA", { style: "currency", currency: "USD", currencyDisplay: "narrowSymbol" }).format(cents / 100);
}

/** What the buyer sees for each order status. */
export const STATUS_LABEL: Record<string, string> = {
  pending_payment: "Esperando tu pago",
  paid: "Pagada",
  seller_notified: "Pagada · avisamos al vendedor",
  shipped: "Enviada",
  delivered: "Entregada",
  payout_released: "Completada",
  expired: "Expirada",
  cancelled: "Cancelada",
  rejected: "Rechazada",
  refunded: "Reembolsada",
  under_review: "En revisión",
};
