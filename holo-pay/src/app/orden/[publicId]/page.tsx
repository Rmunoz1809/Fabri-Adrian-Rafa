import WaitForPayment from "./wait";

export default async function OrderPage({ params }: { params: Promise<{ publicId: string }> }) {
  const { publicId } = await params;
  return (
    <main className="wrap narrow">
      <WaitForPayment publicId={publicId} />
    </main>
  );
}
