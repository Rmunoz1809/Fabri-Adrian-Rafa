/** Seller notification. For now a log; later WhatsApp or email. */
export type PaidOrderNotice = { publicId: string; listingTitle: string; sellerName: string; totalCents: number };

export interface SellerNotifier {
  orderPaid(notice: PaidOrderNotice): Promise<void>;
}

export const logSellerNotifier: SellerNotifier = {
  async orderPaid(n) {
    // No buyer phone or payment tokens in logs.
    console.info(`[notify] seller "${n.sellerName}": order ${n.publicId} paid (${n.listingTitle}, ${n.totalCents} cents)`);
  },
};
