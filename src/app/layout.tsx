import type { Metadata, Viewport } from "next";
import { Bricolage_Grotesque, Inter } from "next/font/google";
import Link from "next/link";
import { APP_NAME } from "@/lib/catalog";
import "./globals.css";

const inter = Inter({ variable: "--font-inter", subsets: ["latin"] });
const bricolage = Bricolage_Grotesque({ variable: "--font-bricolage", subsets: ["latin"] });

export const metadata: Metadata = {
  title: { default: `${APP_NAME} · Cartas coleccionables en Panamá`, template: `%s · ${APP_NAME}` },
  description: "Compra y vende cartas Pokémon, NBA y NFL en Panamá, con precio estimado y Compra Protegida.",
};

export const viewport: Viewport = {
  themeColor: [
    { media: "(prefers-color-scheme: light)", color: "#f5f3ee" },
    { media: "(prefers-color-scheme: dark)", color: "#0e0e10" },
  ],
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html lang="es-PA" className={`${inter.variable} ${bricolage.variable} h-full antialiased`}>
      <body className="min-h-full flex flex-col font-sans">
        <header className="sticky top-0 z-30 border-b border-line bg-bg/85 backdrop-blur">
          <div className="mx-auto flex h-14 max-w-6xl items-center gap-3 px-4">
            <Link href="/" className="flex items-center gap-2 font-display text-xl font-bold tracking-tight">
              <span aria-hidden className="inline-block size-5 rounded-md" style={{ background: "var(--holo)" }} />
              {APP_NAME}
            </Link>
            <form action="/" className="ml-2 hidden flex-1 sm:block">
              <label className="sr-only" htmlFor="q-top">Buscar</label>
              <input
                id="q-top"
                name="q"
                placeholder="Busca Charizard, Wembanyama, Prizm…"
                className="h-9 w-full max-w-md rounded-full border border-line bg-surface px-4 text-sm outline-none placeholder:text-ink-2 focus:border-accent"
              />
            </form>
            <nav className="ml-auto flex items-center gap-1 text-sm">
              <Link href="/protegida" className="hidden rounded-full px-3 py-2 text-ink-2 hover:text-ink md:block">
                Compra Protegida
              </Link>
              <Link
                href="/vender"
                className="rounded-full bg-accent px-4 py-2 font-semibold text-accent-ink hover:opacity-90"
              >
                Vender
              </Link>
            </nav>
          </div>
        </header>
        <main className="flex-1">{children}</main>
        <footer className="border-t border-line">
          <div className="mx-auto flex max-w-6xl flex-col gap-2 px-4 py-8 text-sm text-ink-2 sm:flex-row sm:justify-between">
            <p>© 2026 {APP_NAME} · Hecho en Panamá 🇵🇦 · Precios en USD</p>
            <p>Los precios estimados son referencias, no garantías ni tasaciones oficiales.</p>
          </div>
        </footer>
      </body>
    </html>
  );
}
