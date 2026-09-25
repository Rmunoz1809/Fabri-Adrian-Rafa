# Fase 1 · Especificación de producto (MVP)

**Fecha:** 2026-09-25 · **Alcance elegido:** clasificados + IA, con Compra Protegida manual (concierge).

> El análisis de negocio ([01](01-business-analysis.md)) recomendó NO-GO como startup. Fabrizio decidió seguir. Por eso este MVP está diseñado para **aprender barato**: sin pasarela de pagos, sin chat propio y sin app móvil hasta que haya señales de demanda.

## Personas

| Persona | Qué quiere | Qué le damos en el MVP |
|---|---|---|
| **Coleccionista casual de Pokémon** (15–30 años) | Comprar singles sin que lo estafen y saber si el precio es justo | Rango de precio en cada anuncio y Compra Protegida |
| **Inversionista de sports cards** | Comprar y vender graded rápido y con liquidez local | Filtro de graduadas, comparables de ventas locales y verificación del cert |
| **Tienda local de cartas** | Un canal más para mover inventario | Publicación gratis y badge de tienda verificada |
| **Papá o mamá que compra para un hijo** | No pagar de más ni comprar una réplica | Etiqueta "Buen precio / Sobre el mercado" y Compra Protegida |

## Flujo principal (MVP)

1. **Vender:** foto → la IA identifica la carta y llena el formulario → el vendedor ve el rango estimado → elige precio y barrio → publica.
2. **Comprar:** navega o busca → filtra → abre el anuncio → ve el rango y la etiqueta de precio → elige:
   - **Preguntar por WhatsApp** (al número de la plataforma, no al del vendedor), o
   - **Comprar protegido:** paga a la plataforma por Yappy → nosotros verificamos la carta en persona → entregamos → liberamos el pago al vendedor.
3. **Calificar:** después de una orden liberada.

## MVP / v2 / después

| MVP (ahora) | v2 (si hay tracción) | Después |
|---|---|---|
| Anuncios con fotos, búsqueda y filtros | Chat dentro de la app y ofertas | App móvil (Expo) |
| IA: reconocimiento, estimación de precio, revisión visual y alertas de autenticidad | Pasarela (Tilopay/PagueloFacil) con retención | Envío en lote a PSA |
| Compra Protegida manual (WhatsApp + Yappy) | Alertas de ofertas y asistente de búsqueda en lenguaje natural | Subastas y breaks en vivo |
| Registro con Supabase Auth | Moderación automática con IA | Nuevas categorías (One Piece, Magic, fútbol) |
| Panel mínimo de staff (órdenes y reportes) | Perfiles públicos de vendedor | Bóveda o consignación |

**Fuera del MVP a propósito:** chat propio (WhatsApp ya lo resuelve), pagos automáticos (requieren abogado y pasarela), app nativa (la web móvil basta para validar).

## Comisiones (Compra Protegida)

La paga el **comprador**; publicar es gratis para el vendedor. Se configura en [`src/lib/fees.ts`](../src/lib/fees.ts).

| Concepto | Valor |
|---|---|
| Tasa | 5% del precio + $1.00 |
| Mínimo / máximo | $2.00 / $50.00 |
| ITBMS | 7% sobre la tarifa |
| Ejemplo con una carta de $100 | $6.00 + $0.42 de ITBMS = $106.42 de total |

## Funciones de IA (prioridad y costo)

| # | Función | En el MVP | Modelo / fuente | Costo estimado por uso |
|---|---|---|---|---|
| 1 | Reconocimiento por foto | ✅ | Claude Opus 5 (vision, effort bajo) | ~$0.01–0.03 [E] |
| 2 | Precio estimado | ✅ | Pokémon: TCGplayer vía pokemontcg.io (gratis). Sports y graduadas: solo ventas locales (≥3) | $0 |
| 3 | Revisión visual de condición | ✅ (en la misma llamada que el 1) | Claude | incluido |
| 4 | Señales de réplica | ✅ (en la misma llamada que el 1) | Claude + precio anómalo | incluido |
| 5 | Título en español | ✅ (en la misma llamada que el 1) | Claude | incluido |
| 6 | Asistente de búsqueda y alertas | v2 | Claude | ~$0.005 |
| 7 | Moderación | v2 | Claude (effort bajo) | ~$0.002 |

**Cómo mantener bajo el costo:** una sola llamada por publicación cubre las funciones 1, 3, 4 y 5. Las respuestas de pokemontcg.io se cachean 12 horas. Límite de 2 fotos de 5 MB.

**Regla de honestidad:** si no hay datos, **no se muestra estimado**. Nunca se inventa un precio para cartas deportivas.

## Métricas

- Anuncios nuevos por semana y porcentaje con foto real
- Relación compradores/vendedores (contactos por anuncio)
- Conversión: contactos → Compra Protegida
- Take rate efectivo = ingresos / GMV total reportado
- Disputas y réplicas detectadas por cada 100 órdenes
- Porcentaje de compradores que repiten en 60 días
- **Métrica que decide el siguiente paso:** ≥20 Compras Protegidas pagadas en las primeras 4 semanas después del lanzamiento.
