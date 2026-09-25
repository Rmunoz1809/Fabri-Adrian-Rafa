import type { Metadata } from "next";
import Link from "next/link";
import { getCurrentUser, isSupabaseConfigured } from "@/lib/supabase/server";
import { SellForm } from "./SellForm";

export const metadata: Metadata = { title: "Vender una carta" };

export default async function SellPage() {
  const needsLogin = isSupabaseConfigured() && !(await getCurrentUser());

  return (
    <div className="mx-auto max-w-5xl px-4 pb-16 pt-6">
      <h1 className="font-display text-3xl font-bold tracking-tight">Vende tu carta</h1>
      <p className="mt-1 max-w-xl text-ink-2">
        Publicar es gratis. Sube una foto y la IA llena los datos y te sugiere un rango de precio.
      </p>
      {needsLogin ? (
        <div className="mt-6 max-w-md rounded-3xl border border-line bg-surface p-6">
          <p className="font-medium">Entra o crea tu cuenta para publicar.</p>
          <p className="mt-1 text-sm text-ink-2">Toma menos de un minuto.</p>
          <Link
            href="/entrar?next=/vender"
            className="mt-4 flex h-12 items-center justify-center rounded-xl bg-accent font-semibold text-accent-ink"
          >
            Entrar o crear cuenta
          </Link>
        </div>
      ) : (
        <div className="mt-6">
          <SellForm />
        </div>
      )}
    </div>
  );
}
