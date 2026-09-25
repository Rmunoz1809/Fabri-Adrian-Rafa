// During the concierge phase every conversation goes through the platform's own
// WhatsApp number. That keeps the transaction (and the fee) on-platform and lets
// us learn what buyers ask before building in-app chat.
export function platformWhatsapp(): string | null {
  const n = process.env.NEXT_PUBLIC_WHATSAPP_NUMBER?.replace(/\D/g, "");
  return n ? n : null;
}

export function whatsappLink(message: string): string | null {
  const n = platformWhatsapp();
  return n ? `https://wa.me/${n}?text=${encodeURIComponent(message)}` : null;
}
