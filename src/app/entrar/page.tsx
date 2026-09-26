import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { safeNext } from "@/lib/safe-next";
import { getCurrentUser } from "@/lib/supabase/server";
import { AuthForm } from "./AuthForm";

export const metadata: Metadata = { title: "Entrar" };

export default async function SignInPage({ searchParams }: PageProps<"/entrar">) {
  const next = safeNext((await searchParams).next);
  if (await getCurrentUser()) redirect(next);

  return (
    <div className="mx-auto max-w-md px-4 pb-16 pt-10">
      <h1 className="font-display text-3xl font-bold tracking-tight">Tu cuenta</h1>
      <p className="mt-1 text-ink-2">Necesitas una cuenta para publicar cartas.</p>
      <div className="mt-6">
        <AuthForm next={next} />
      </div>
    </div>
  );
}
