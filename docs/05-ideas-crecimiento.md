# Ideas para crecer y generar más dinero

**Fecha:** 2026-09-27 · **Base:** `main` en `3626f69` · Leyenda: **[E]** estimación mía, a validar con datos reales.

**Criterio:** cada idea se juzga por tres cosas:
1. Si nos acerca a la meta de lanzamiento (**20 Compras Protegidas pagadas en 4 semanas**).
2. Si genera ingresos.
3. Cuánto trabajo cuesta.

Ya decidido y fuera de esta lista:
- Hechos: Compra Protegida sin verificación en persona y Revisión en tienda.
- Aprobados, para más adelante: Tienda Pro y Plan Coleccionista.
- Descartado: el envío grupal a graduar.

---

## Lo más importante primero

El problema de fondo no cambió desde el [análisis de negocio](01-business-analysis.md): **Panamá es un mercado chico** (unos $0.8–2M al año en ventas entre coleccionistas [E]) y la gente cierra tratos por WhatsApp sin pagar comisión. Por eso las mejores ideas hacen una de estas tres cosas:

1. **Traen gente sin gastar en publicidad** (el escáner de valor y compartir).
2. **Cobran por algo que WhatsApp no da:** confianza, visibilidad y datos.
3. **Agrandan el mercado:** otras tiendas como clientes, u otros países.

---

## 1. Ideas para la web

### A. Traer gente (crecimiento)

| # | Idea | Por qué funciona | Esfuerzo |
|---|---|---|---|
| 1 | **"¿Cuánto vale mi carta?"**: escáner público. Subes una foto y te decimos qué carta es y su valor de mercado. El resultado trae el botón "Véndela en Holo" | Es la pregunta que todo coleccionista se hace. Sirve como contenido para TikTok e Instagram ("escaneé mi binder de niño…") y trae registros. Ya tenemos la IA, solo falta la pantalla | Bajo: 1–2 días |
| 2 | **Imagen para historias de Instagram** (formato 9:16) además de la de WhatsApp | Los vendedores comparten en historias, no en el feed | Bajo |
| 3 | **Invita a un vendedor:** si publica 3 cartas, los dos reciben un "Destacado" gratis | Crece la oferta sin gastar en publicidad | Bajo |
| 4 | **Calendario de torneos y preventas** de las tiendas | Hace que la gente vuelva cada semana y le da a las tiendas una razón para usar Holo | Bajo |
| 5 | **Páginas de precio por carta** que Google pueda encontrar ("precio Charizard 151 Panamá") | Tráfico gratis a largo plazo. Requiere páginas sin `#` en la dirección, un cambio técnico mediano | Medio |

### B. Más cartas publicadas (oferta)

| # | Idea | Por qué funciona | Esfuerzo |
|---|---|---|---|
| 6 | **Publicar un binder completo con una foto**: la IA reconoce las 9 cartas de una página y crea 9 anuncios en borrador | Publicar de a una carta cansa; así una tienda sube 100 cartas en una tarde. Nadie en Panamá lo tiene | Medio: 3–4 días |
| 7 | **Carga masiva por Excel** para tiendas (carta, condición, precio) | Las tiendas ya tienen su inventario en una lista | Medio |
| 8 | **Anuncios que vencen a los 30 días** con aviso para renovar | Los anuncios de cartas ya vendidas matan la confianza | Bajo |

### C. Más ventas (conversión y confianza)

| # | Idea | Por qué funciona | Esfuerzo |
|---|---|---|---|
| 9 | **"Busco…"**: el comprador guarda la carta que quiere y le avisamos cuando alguien la publica | Captura demanda que hoy se pierde y nos dice qué se busca en Panamá. Gratis ahora; las alertas ilimitadas van en el Plan Coleccionista | Medio |
| 10 | **"Hacer oferta"**: un mensaje de WhatsApp ya escrito con el monto | En Panamá se regatea; hoy solo hay precio fijo | Bajo |
| 11 | **Reseñas después de cada Compra Protegida** | Las primeras reseñas reales valen oro. La tabla `reviews` ya existe | Bajo |
| 12 | **"Ventas completadas"** en el perfil, contando solo ventas reales por Compra Protegida | Es la señal de confianza más fuerte y no se puede falsificar | Bajo |
| 13 | **Canje (intercambio)**: publicas qué tienes y qué buscas, y te mostramos coincidencias | Muchos coleccionistas prefieren cambiar antes que vender. Un canje protegido se puede cobrar | Alto |

### D. Que la gente vuelva (retención)

| # | Idea | Por qué funciona | Esfuerzo |
|---|---|---|---|
| 14 | **Mi colección**: registras tus cartas y ves cuánto vale tu colección en el tiempo | Es lo que hace Collectr y engancha a diario. Cada carta registrada es una posible venta ("véndela con un toque") | Alto |
| 15 | **Resumen semanal por correo o WhatsApp**: nuevas cartas de lo que buscas y cartas que subieron de precio | Trae de vuelta a la gente sin pagar publicidad | Medio |

---

## 2. Nuevas formas de ganar dinero

Además de lo que ya tenemos (comisión de Compra Protegida y Revisión en tienda) y lo aprobado (Tienda Pro y Plan Coleccionista):

| # | Idea | Cuánto se cobra [E] | Comentario |
|---|---|---|---|
| 16 | **Destacar anuncio** | $2 por 7 días | Es el cobro más fácil de empezar. Se paga por Yappy y lo activan desde el panel |
| 17 | **Links de afiliado** a eBay y TCGplayer en la gráfica de precios ("Ver en eBay") | 1–4% de lo que compren allá | Mucha gente compra en EE. UU. de todos modos, así que ganamos algo también ahí. Poco trabajo; hay que registrarse en eBay Partner Network e Impact (TCGplayer) |
| 18 | **Subasta semanal "Drop del viernes"**: 10 cartas curadas con subasta en vivo por Instagram o en la web | 8–10% de cada venta | Vender como entretenimiento, como Whatnot. Crea hábito y contenido |
| 19 | **Torneos mensuales Holo** con una tienda aliada: inscripción y premios en cartas | $5–10 por jugador; los premios los pone la tienda o un patrocinador | Nos da presencia en la comunidad y la tienda gana visitas |
| 20 | **Publicidad de tiendas y eventos** en la portada | $10–20 por semana | Solo cuando haya tráfico |
| 21 | **Reporte de mercado mensual** para tiendas: qué se busca, qué se vende y a qué precio en Panamá | $15–30 al mes, o incluido en Tienda Pro | Nuestros datos de "Busco…" y ventas son únicos en el país |
| 22 | **Valoración de colección en PDF** (para seguros, herencias o venta completa) | $15–25 | Usa los precios que ya calculamos. Hay que dejar claro que es una referencia, no una tasación oficial |
| 23 | **Tarifa de envío con courier aliado** (Uno Express u otro): Holo ofrece la guía con tarifa negociada | $1–2 de margen por envío | Resuelve el envío a provincias dentro de Compra Protegida |
| 24 | **Consignación por medio de tiendas aliadas**: la tienda guarda la carta y la vende en Holo, y Holo cobra su parte | 3–5% para Holo | Holo no toca la carta, igual que en la Revisión en tienda |

---

## 3. Ideas para el negocio

1. **Expansión regional.** Es lo único que cambia el techo del mercado. Costa Rica, Guatemala, El Salvador, República Dominicana y Colombia tienen el mismo idioma y el mismo problema. La página ya está en español y en dólares; lo que cambia por país es el medio de pago (Yappy solo existe en Panamá). **Conviene hacerlo solo después de probar el modelo en Panamá** (las 20 Compras Protegidas y la recompra).
2. **Holo para tiendas (B2B).** Inventario, precios actualizados solos y publicación automática en Holo e Instagram, por $25–49 al mes. Es la evolución de Tienda Pro y encaja con Pedidito, otra idea de Fabrizio (pedidos por DM y cobro por Yappy). Una tienda que paga todos los meses vale más que muchas comisiones sueltas.
3. **Alianza con una tienda grande como socio de confianza.** Que su local sea el punto de revisión, de torneos y de consignación. Nos da presencia física sin pagar alquiler.
4. **Datos propios de precios en Panamá.** Cada venta marcada con su precio final alimenta el único índice de precios local. Con el tiempo, **eso es lo que no se puede copiar**, a diferencia de los precios de eBay y PriceCharting, que además tienen el problema de derechos.

---

## 4. Qué haría y en qué orden

**Próximas 4 semanas (lanzamiento):** pocas cosas, todas para llegar a las 20 Compras Protegidas.

| Orden | Qué | Por qué ahora |
|---|---|---|
| 1 | Escáner "¿Cuánto vale mi carta?" (#1) | Trae registros y contenido para redes |
| 2 | Hacer oferta (#10) + reseñas (#11) + ventas completadas (#12) | Más confianza y más ventas cerradas, con poco trabajo |
| 3 | Destacar anuncio (#16) | El primer ingreso nuevo, fácil de cobrar |
| 4 | "Busco…" (#9) | Captura demanda y nos dice qué cartas conseguir |
| 5 | Links de afiliado (#17) | Casi sin trabajo |

**Meses 2–3 (con tiendas activas):** publicar binder con una foto (#6), Tienda Pro, torneo mensual (#19), subasta semanal (#18) y calendario de eventos (#4).

**Meses 4–6 (si hay tracción):** Plan Coleccionista con Mi colección (#14), resumen semanal (#15), páginas para Google (#5) y probar un segundo país.

**Lo que no haría todavía:** app nativa, pasarela de pago automática, chat propio y bóveda o custodia de cartas. Cuestan semanas y no ayudan a las primeras 20 ventas.

---

## 5. Cuánto podría dejar (escenario medio a 6 meses) [E]

| Fuente | Cálculo | Al mes |
|---|---|---|
| Compra Protegida | 60 órdenes × ~$3 de comisión | ~$180 |
| Destacados | 100 × $2 | ~$200 |
| Tienda Pro | 5 tiendas × $25 | ~$125 |
| Plan Coleccionista | 40 × $4 | ~$160 |
| Revisión en tienda | 20 × ~$2 que le quedan a Holo | ~$40 |
| Afiliados, torneos y publicidad | — | ~$100–200 |
| **Total** | | **~$800–900 al mes** |

**Lectura honesta:** alcanza para cubrir costos y validar el modelo, pero no es un negocio grande solo en Panamá. **Los saltos grandes vienen del B2B para tiendas y de la expansión regional.** Por eso lo importante del lanzamiento es medir si la gente usa Compra Protegida y vuelve a comprar; con esos datos se decide si vale la pena escalar.
