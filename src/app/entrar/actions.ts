"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export type AuthState = { error?: string; info?: string } | null;

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email("Correo no válido."),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
});

// Only allow internal redirects after login.
function safeNext(v: FormDataEntryValue | null): string {
  const s = typeof v === "string" ? v : "";
  return s.startsWith("/") && !s.startsWith("//") ? s : "/";
}

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Las cuentas aún no están activadas." };
  const parsed = Credentials.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword(parsed.data);
  if (error) {
    return {
      error: error.code === "email_not_confirmed"
        ? "Confirma tu correo antes de entrar."
        : "Correo o contraseña incorrectos.",
    };
  }
  redirect(safeNext(form.get("next")));
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Las cuentas aún no están activadas." };
  const parsed = Credentials.extend({
    displayName: z.string().trim().min(2, "Escribe tu nombre (mínimo 2 letras).").max(40),
  }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { email, password, displayName } = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: { data: { display_name: displayName } },
  });
  if (error) {
    if (error.code === "user_already_exists") return { error: "Ya existe una cuenta con ese correo." };
    if (error.code === "over_email_send_rate_limit") return { error: "Demasiados intentos. Prueba en unos minutos." };
    return { error: "No pudimos crear la cuenta. Intenta de nuevo." };
  }
  if (!data.session) return { info: "Te enviamos un correo para confirmar tu cuenta." };
  redirect(safeNext(form.get("next")));
}

export async function signOut() {
  if (isSupabaseConfigured()) {
    const supabase = await createClient();
    await supabase.auth.signOut();
  }
  redirect("/");
}
