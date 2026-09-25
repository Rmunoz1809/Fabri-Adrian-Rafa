"use client";

import { useActionState, useState } from "react";
import { signIn, signUp, type AuthState } from "./actions";

const field = "h-11 w-full rounded-xl border border-line bg-surface px-3 text-base outline-none focus:border-accent sm:text-sm";

export function AuthForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"entrar" | "registro">("entrar");
  const [inState, inAction, inPending] = useActionState<AuthState, FormData>(signIn, null);
  const [upState, upAction, upPending] = useActionState<AuthState, FormData>(signUp, null);
  const isUp = mode === "registro";
  const state = isUp ? upState : inState;
  const pending = isUp ? upPending : inPending;

  return (
    <div className="rounded-3xl border border-line bg-surface p-6">
      <div className="grid grid-cols-2 gap-1 rounded-xl bg-surface-2 p-1 text-sm font-medium">
        {(["entrar", "registro"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => setMode(m)}
            className={`h-9 rounded-lg ${mode === m ? "bg-surface shadow-sm" : "text-ink-2"}`}
          >
            {m === "entrar" ? "Entrar" : "Crear cuenta"}
          </button>
        ))}
      </div>

      <form action={isUp ? upAction : inAction} className="mt-5 flex flex-col gap-3" key={mode}>
        <input type="hidden" name="next" value={next} />
        {isUp && (
          <label className="flex flex-col gap-1.5 text-sm font-medium">
            Nombre para mostrar
            <input name="displayName" required minLength={2} maxLength={40} autoComplete="nickname" className={field} />
          </label>
        )}
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Correo
          <input name="email" type="email" required autoComplete="email" className={field} />
        </label>
        <label className="flex flex-col gap-1.5 text-sm font-medium">
          Contraseña
          <input
            name="password"
            type="password"
            required
            minLength={8}
            autoComplete={isUp ? "new-password" : "current-password"}
            className={field}
          />
        </label>
        {state?.error && <p className="rounded-xl bg-bad-bg p-3 text-sm text-bad">{state.error}</p>}
        {state?.info && <p className="rounded-xl bg-good-bg p-3 text-sm text-good">{state.info}</p>}
        <button disabled={pending} className="mt-1 h-12 rounded-xl bg-accent font-semibold text-accent-ink disabled:opacity-60">
          {pending ? "Un momento…" : isUp ? "Crear cuenta" : "Entrar"}
        </button>
        {isUp && (
          <p className="text-xs text-ink-2">
            Al crear tu cuenta aceptas que tratemos tus datos para operar el marketplace (Ley 81 de 2019). Nunca
            mostramos tu correo ni tu dirección.
          </p>
        )}
      </form>
    </div>
  );
}
