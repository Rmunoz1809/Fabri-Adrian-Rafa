"use client";

import { useActionState, useEffect, useRef, useState, startTransition, type FormEvent } from "react";
import { PRIVACY_URL, TERMS_URL } from "@/lib/legal";
import { signIn, signUp, type AuthState } from "./actions";

const field = "h-11 w-full rounded-xl border border-line bg-surface px-3 text-base outline-none focus:border-accent sm:text-sm";
// Cloudflare Turnstile, like holo.html. Empty = no captcha (Supabase must not require it then).
const TURNSTILE_SITE_KEY = process.env.NEXT_PUBLIC_TURNSTILE_SITE_KEY ?? "";

type Turnstile = {
  render(el: HTMLElement, opts: Record<string, unknown>): string;
  reset(id: string): void;
  remove(id: string): void;
};
declare global {
  interface Window { turnstile?: Turnstile }
}

let turnstileScript: Promise<Turnstile> | null = null;
function loadTurnstile(): Promise<Turnstile> {
  turnstileScript ??= new Promise((resolve, reject) => {
    const s = document.createElement("script");
    s.src = "https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit";
    s.async = true;
    s.onload = () => (window.turnstile ? resolve(window.turnstile) : reject(new Error("turnstile missing")));
    s.onerror = () => { turnstileScript = null; reject(new Error("turnstile load failed")); };
    document.head.appendChild(s);
  });
  return turnstileScript;
}

/** Invisible-until-needed captcha; the token goes in a hidden field and is renewed after each attempt. */
function Captcha({ attempt, onToken }: { attempt: unknown; onToken: (token: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const widget = useRef<{ ts: Turnstile; id: string } | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    loadTurnstile().then((ts) => {
      if (cancelled || !box.current) return;
      const id = ts.render(box.current, {
        sitekey: TURNSTILE_SITE_KEY, language: "es", theme: "auto", appearance: "interaction-only",
        size: box.current.clientWidth < 300 ? "compact" : "flexible",
        callback: (t: string) => onToken(t),
        "expired-callback": () => onToken(""),
      });
      widget.current = { ts, id };
    }).catch(() => setFailed(true));
    return () => {
      cancelled = true;
      if (widget.current) widget.current.ts.remove(widget.current.id);
      widget.current = null;
    };
  }, [onToken]);

  // Tokens are single-use: get a fresh one after every attempt.
  useEffect(() => {
    if (attempt && widget.current) { onToken(""); widget.current.ts.reset(widget.current.id); }
  }, [attempt, onToken]);

  return failed
    ? <p className="rounded-xl bg-bad-bg p-3 text-sm text-bad">No se pudo cargar la verificación. Recarga la página.</p>
    : <div ref={box} />;
}

export function AuthForm({ next }: { next: string }) {
  const [mode, setMode] = useState<"entrar" | "registro">("entrar");
  const [inState, inAction, inPending] = useActionState<AuthState, FormData>(signIn, null);
  const [upState, upAction, upPending] = useActionState<AuthState, FormData>(signUp, null);
  const [captchaToken, setCaptchaToken] = useState("");
  const [localError, setLocalError] = useState<string | null>(null);
  const isUp = mode === "registro";
  const state = isUp ? upState : inState;
  const pending = isUp ? upPending : inPending;

  // onSubmit (not <form action>) so a failed attempt keeps what the user typed.
  function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (TURNSTILE_SITE_KEY && !captchaToken) { setLocalError("Completa la verificación de seguridad."); return; }
    setLocalError(null);
    const fd = new FormData(e.currentTarget);
    startTransition(() => (isUp ? upAction : inAction)(fd));
  }

  return (
    <div className="rounded-3xl border border-line bg-surface p-6">
      <div className="grid grid-cols-2 gap-1 rounded-xl border border-line bg-surface-2 p-1 text-sm">
        {(["entrar", "registro"] as const).map((m) => (
          <button
            key={m}
            type="button"
            onClick={() => { setMode(m); setLocalError(null); }}
            aria-pressed={mode === m}
            className={`h-10 rounded-lg font-semibold ${mode === m ? "bg-accent text-accent-ink shadow-sm" : "text-ink hover:bg-surface"}`}
          >
            {m === "entrar" ? "Entrar" : "Crear cuenta"}
          </button>
        ))}
      </div>

      <form onSubmit={onSubmit} className="mt-5 flex flex-col gap-3" key={mode}>
        <input type="hidden" name="next" value={next} />
        <input type="hidden" name="captchaToken" value={captchaToken} />
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
        {isUp && (
          <label className="flex items-start gap-2 text-xs text-ink-2">
            <input type="checkbox" name="accept" required className="mt-0.5" />
            <span>
              Acepto los <a href={TERMS_URL} target="_blank" rel="noopener" className="underline">Términos y condiciones</a> y
              la <a href={PRIVACY_URL} target="_blank" rel="noopener" className="underline">Política de privacidad</a>, incluido
              el tratamiento de mis datos según la Ley 81 de 2019. Nunca mostramos tu correo ni tu dirección.
            </span>
          </label>
        )}
        {TURNSTILE_SITE_KEY && <Captcha attempt={state} onToken={setCaptchaToken} />}
        {(localError || state?.error) && <p className="rounded-xl bg-bad-bg p-3 text-sm text-bad">{localError ?? state?.error}</p>}
        {state?.info && <p className="rounded-xl bg-good-bg p-3 text-sm text-good">{state.info}</p>}
        <button disabled={pending} className="mt-1 h-12 rounded-xl bg-accent font-semibold text-accent-ink disabled:opacity-60">
          {pending ? "Un momento…" : isUp ? "Crear cuenta" : "Entrar"}
        </button>
      </form>
    </div>
  );
}
