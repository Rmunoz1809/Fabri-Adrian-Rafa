# Fase 2 · Arquitectura

## Stack

| Capa | Elección | Por qué |
|---|---|---|
| Web | Next.js 16 (App Router) + TypeScript + Tailwind 4 | SSR para SEO de los anuncios; un solo repo |
| Backend | Server Components, Server Actions y Route Handlers | Sin servidor aparte |
| DB, auth y fotos | Supabase (Postgres + RLS + Storage) | Plan gratis, seguridad por filas, auth con email/Google |
| IA | Claude API (`claude-opus-5`, vision + structured outputs) | Una llamada devuelve JSON validado con zod |
| Precios | pokemontcg.io (TCGplayer) + tabla propia `sales` | Gratis; los datos locales se vuelven el activo propio |
| Mapa | Solo barrio (lista fija) | Privacidad del vendedor; no hace falta un mapa |
| Pagos | Manual: Yappy Comercial a la cuenta de la empresa | Stripe no opera en Panamá; la pasarela queda para v2 |
| Móvil | Web móvil primero; Expo en v2 (puede compartir `src/lib`) | No construir dos apps antes de validar |

## Estructura

```
src/
  app/                 páginas (/, /carta/[id], /vender, /protegida) y /api/recognize
  components/          UI (CardArt, ListingCard, EstimatePanel, Filters, Badges)
  lib/
    types.ts           modelo de dominio
    catalog.ts         categorías, condiciones, ubicaciones
    fees.ts            comisión de Compra Protegida (+ tests)
    pricing/           estimatePrice (+ tests) y cliente de pokemontcg.io
    ai/recognize.ts    Claude vision → JSON
    data/              repositorio (datos demo hoy, Supabase después)
supabase/migrations/   esquema + RLS + bucket de fotos
```

## Modelo de datos

Está en [`supabase/migrations/0001_init.sql`](../supabase/migrations/0001_init.sql): `profiles`, `categories`, `cards`, `listings`, `listing_photos`, `price_snapshots`, `sales`, `protected_orders`, `reviews` y `reports`.

## Seguridad

- **RLS** en todas las tablas. Solo staff escribe `protected_orders`, `sales` y `cards`.
- **Triggers** que impiden que un usuario se marque como staff o verificado, o que habilite Compra Protegida en su propio anuncio. `REVOKE` por columna no sirve con los grants por defecto de Supabase.
- El **WhatsApp del vendedor** es privado: la vista `public_profiles` no lo expone.
- **Fotos:** máximo 5 MB, JPG/PNG/WebP, cada usuario sube solo a su carpeta.
- **IA:** máximo 2 fotos por llamada. En `holo.html` la IA corre en la Edge Function `supabase/functions/identificar-carta` (exige sesión; límite de 30 llamadas por hora por usuario, en memoria de cada instancia). Sin la función, el navegador usa OCR + TCGdex.

## Costo mensual estimado [E]

| Usuarios | Vercel | Supabase | Claude (1 llamada por anuncio) | Total |
|---|---|---|---|---|
| 100 | $0 (Hobby) | $0 (Free) | ~$2 | **~$2** |
| 1,000 | $20 (Pro, necesario si hay uso comercial) | $25 (Pro) | ~$15 | **~$60** |
| 10,000 | $20+ | $25–75 | ~$120 | **~$170–220** |

Supuestos: 30% de los usuarios publica 1–2 anuncios al mes y cada llamada cuesta ~$0.02. Hay que medir el costo real con `usage` en las primeras semanas.

## Despliegue

1. Crear el proyecto en Supabase, correr la migración y configurar las variables de `.env.example`.
2. Deploy en Vercel conectado al repo.
3. Dominio: pendiente de decisión de nombre (el nombre "Holo" es provisional).
