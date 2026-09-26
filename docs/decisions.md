# Registro de decisiones

| Fecha | Decisión | Por qué |
|---|---|---|
| 2026-09-24 | Primera evaluación (Pokémon/fútbol): NO-GO | El GMV de Panamá no alcanza para $10k MRR; las tiendas ya venden con Yappy y delivery; el de minimis de $100 facilita importar |
| 2026-09-25 | Re-evaluación con NBA/NFL e IA: se mantiene NO-GO; PIVOT opcional a concierge de confianza o a tiendas TCG como clientes de Pedidito | NBA/NFL es un nicho chico; los datos de precios (eBay, PriceCharting) no se pueden mostrar al público sin acuerdo comercial; la IA de escaneo es un commodity |
| 2026-09-25 | Docs en `cartas/docs/` | El directorio de trabajo tiene varios proyectos; se aísla este |
| 2026-09-25 | Fase 1 en pausa hasta la aprobación | Instrucción explícita del prompt |
| 2026-09-25 | Fabrizio decide seguir y construir pese al NO-GO | Decisión del fundador; el MVP se diseña para aprender barato |
| 2026-09-25 | Alcance del MVP: clasificados + IA, con Compra Protegida manual (concierge por WhatsApp + Yappy) | Valida la demanda sin pasarela, sin abogado y sin chat propio |
| 2026-09-25 | Todo contacto pasa por el WhatsApp de la plataforma, no por el del vendedor | Mantiene la transacción (y la comisión) dentro de la plataforma y nos deja aprender |
| 2026-09-25 | La comisión la paga el comprador: 5% + $1 (mín. $2, máx. $50) + 7% de ITBMS; publicar es gratis | Nada frena la oferta; el comprador paga por la protección (modelo Vinted) |
| 2026-09-25 | Precio estimado: TCGplayer vía pokemontcg.io para Pokémon raw; solo ventas locales (≥3) para sports y graduadas; si no hay datos, no hay número | PriceCharting y eBay no permiten mostrar sus datos; no inventamos precios |
| 2026-09-25 | Stack: Next.js 16 + Supabase + Claude Opus 5; web móvil primero, Expo en v2 | Un solo codebase; la app nativa no valida nada nuevo |
| 2026-09-25 | Nombre provisional "Holo" (constante APP_NAME) | Fácil de cambiar; falta decidir marca y dominio |
| 2026-09-25 | Node 22 LTS instalado en ~/.local/node (sin Homebrew) | No había Node; instalación sin sudo |
| 2026-09-25 | pokemontcg.io sigue sin API key (ya no acepta registros; la API queda obsoleta el 2027-03-01). Hay reintentos con backoff y caché de 12 h. Migrar a Scrydex (desde $29/mes, incluye precios de graduadas) cuando el MVP valide | Evita un costo fijo antes de tener señales; la fecha límite da margen |
| 2026-09-25 | La comisión baja a **4%, mínimo $1 y máximo $40** (sin cargo fijo). Reemplaza el esquema de 5% + $1 | A Fabrizio le pareció alta; en Panamá la alternativa es WhatsApp al 0%, y el mínimo anterior de $2 era 20% en una carta de $10 |
| 2026-09-26 | `price_snapshots` usa el esquema de Rafa (`supabase/price_snapshots.sql`: por `catalog_id` y día, llenado diario con pg_cron). Se quitó la versión vieja de `0001_init.sql`, y su SQL borra esa tabla vieja si está vacía | La tabla vieja nunca se usó y chocaba con su `create table if not exists`: sus funciones habrían fallado en silencio |
