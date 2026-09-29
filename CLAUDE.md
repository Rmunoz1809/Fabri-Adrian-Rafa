@AGENTS.md

# Holo: guía para Claude

Marketplace de cartas coleccionables (Pokémon, NBA, NFL) para Panamá. Stack: Next.js 16 + Supabase + Claude API.
Contexto de negocio y decisiones: `docs/` (empieza por `docs/decisions.md`).

## Equipo y GitHub (obligatorio)

Somos **tres socios** trabajando sobre el mismo repositorio de GitHub. GitHub es la fuente de verdad.
Repo: https://github.com/Rmunoz1809/Fabri-Adrian-Rafa (remote `origin`, rama `main`).

1. **Antes de empezar cualquier cambio:** `git pull --rebase` para traer lo que subieron los demás.
2. **Al terminar cada cambio, siempre:**
   - Corre los checks: `npm test`, `npm run typecheck` (genera los tipos de Next y corre `tsc --noEmit`) y `npx eslint src`. No subas nada que falle.
   - Haz commit con un mensaje claro en inglés.
   - Haz **push a GitHub** (`git push`). Un cambio no está terminado hasta que está en GitHub.
3. **Si el push falla porque otro socio subió cambios:** `git pull --rebase`, resuelve conflictos, vuelve a correr los checks y haz push. Nunca uses `git push --force` en `main`.
4. **Nunca subas secretos.** `.env.local` está en `.gitignore`: ahí van la API key de Anthropic y demás claves. Cada socio tiene su propio `.env.local` (plantilla en `.env.example`). Si una clave secreta llega a un commit, avisa de inmediato para rotarla.
5. **Cambios en la base de datos:** van como archivo nuevo en `supabase/migrations/` (nunca edites una migración ya aplicada) y se avisa a los socios, porque hay que ejecutarla en Supabase.
6. **Decisiones importantes:** regístralas en `docs/decisions.md` en el mismo commit.

## Cómo trabajar

- Habla con los socios **en español**. Código, comentarios y mensajes de commit en inglés.
- Node está en `~/.local/node/bin` (sin Homebrew): `export PATH="$HOME/.local/node/bin:$PATH"`.
- Servidor local: `npm run dev`. Sin `NEXT_PUBLIC_SUPABASE_URL` la app usa datos demo.
- Tests obligatorios para pagos, comisiones y permisos (`src/lib/fees.ts`, `src/lib/pricing/`, RLS).
- La comisión de Compra Protegida vive en `src/lib/fees.ts` (5% al vendedor, descontado de lo que recibe; el comprador paga solo el precio; sin mínimo ni máximo, más 7% de ITBMS sobre la comisión). Si cambia, actualiza también `export/holo.html`, `protected_quote()` en Supabase (migración nueva) y `docs/02-product-spec.md`.
- `export/holo.html` es la versión de un solo archivo para compartir. Nunca debe contener claves secretas.
- `holo.html` en la raíz del repo es lo que publica GitHub Pages. Si cambias `export/holo.html`, cópialo también a la raíz (`cp export/holo.html holo.html`) en el mismo commit.
