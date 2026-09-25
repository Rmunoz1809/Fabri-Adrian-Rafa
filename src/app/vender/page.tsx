import type { Metadata } from "next";
import { SellForm } from "./SellForm";

export const metadata: Metadata = { title: "Vender una carta" };

export default function SellPage() {
  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6">
      <h1 className="font-display text-3xl font-bold tracking-tight">Vende tu carta</h1>
      <p className="mt-1 max-w-xl text-ink-2">
        Publicar es gratis. Sube una foto y la IA llena los datos y te sugiere un rango de precio.
      </p>
      <div className="mt-6">
        <SellForm />
      </div>
    </div>
  );
}
