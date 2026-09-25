# Holo · marketplace de cartas coleccionables (Panamá)

MVP de un marketplace de cartas Pokémon, NBA y NFL, con precio estimado y Compra Protegida.

- Negocio: [docs/01-business-analysis.md](docs/01-business-analysis.md)
- Producto: [docs/02-product-spec.md](docs/02-product-spec.md)
- Arquitectura: [docs/03-architecture.md](docs/03-architecture.md)
- Decisiones: [docs/decisions.md](docs/decisions.md)

## Desarrollo

```bash
export PATH="$HOME/.local/node/bin:$PATH"
cp .env.example .env.local   # llena las claves que tengas
npm install
npm run dev                  # http://localhost:3000
npm test                     # comisiones, estimación de precios, filtros
```

Sin `NEXT_PUBLIC_SUPABASE_URL` la app corre con datos demo (`src/lib/data/seed.ts`).
