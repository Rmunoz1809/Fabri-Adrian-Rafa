"use server";

import { redirect } from "next/navigation";
import { z } from "zod";
import { TERMS_VERSION } from "@/lib/legal";
import { safeNext } from "@/lib/safe-next";
import { createClient, isSupabaseConfigured } from "@/lib/supabase/server";

export type AuthState = { error?: string; info?: string } | null;

const Credentials = z.object({
  email: z.string().trim().toLowerCase().email("Correo no válido."),
  password: z.string().min(8, "La contraseña debe tener al menos 8 caracteres."),
});

// Same messages as holo.html for the same Supabase error codes.
function authMessage(code: string | undefined): string {
  switch (code) {
    case "user_already_exists": return "Ya existe una cuenta con ese correo. Usa “Entrar”.";
    case "invalid_credentials": return "Correo o contraseña incorrectos.";
    case "email_not_confirmed": return "Confirma tu correo: te enviamos un enlace al crear la cuenta.";
    case "weak_password": return "La contraseña es muy débil. Usa al menos 8 caracteres.";
    case "captcha_failed": return "La verificación de seguridad falló. Intenta de nuevo.";
    case "over_email_send_rate_limit":
    case "over_request_rate_limit": return "Demasiados intentos. Prueba en unos minutos.";
    default: return "No pudimos completar la operación. Intenta de nuevo.";
  }
}

const captchaOf = (form: FormData) => {
  const t = form.get("captchaToken");
  return typeof t === "string" && t ? t : undefined;
};

export async function signIn(_: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Las cuentas aún no están activadas." };
  const parsed = Credentials.safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const supabase = await createClient();
  const { error } = await supabase.auth.signInWithPassword({ ...parsed.data, options: { captchaToken: captchaOf(form) } });
  if (error) return { error: authMessage(error.code) };
  redirect(safeNext(form.get("next")));
}

export async function signUp(_: AuthState, form: FormData): Promise<AuthState> {
  if (!isSupabaseConfigured()) return { error: "Las cuentas aún no están activadas." };
  const parsed = Credentials.extend({
    displayName: z.string().trim().min(2, "Escribe tu nombre (mínimo 2 letras).").max(40, "El nombre puede tener hasta 40 letras."),
    accept: z.literal("on", { message: "Tienes que aceptar los Términos y la Política de privacidad." }),
  }).safeParse(Object.fromEntries(form));
  if (!parsed.success) return { error: parsed.error.issues[0].message };
  const { email, password, displayName } = parsed.data;
  const supabase = await createClient();
  const { data, error } = await supabase.auth.signUp({
    email,
    password,
    options: {
      captchaToken: captchaOf(form),
      data: { display_name: displayName, terms_version: TERMS_VERSION, terms_accepted_at: new Date().toISOString() },
    },
  });
  if (error) return { error: authMessage(error.code) };
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
