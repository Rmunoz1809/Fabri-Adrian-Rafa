# Fase 0: Análisis de negocio del marketplace de cartas coleccionables en Panamá

**Fecha:** 2026-09-25 · **Estado:** esperando aprobación · **Autor:** Claude (co-fundador técnico) para Fabrizio

> **Contexto importante:** el 2026-09-24 ya evaluamos una versión de esta idea (Pokémon/fútbol, solo Panamá) y el veredicto fue **NO-GO** (~80% de confianza). Esta versión agrega **cartas NBA/NFL** y pone la **IA de valoración** en el centro. Este documento revisa si esas dos variables cambian el veredicto. **Resumen: no lo cambian.** Una de ellas, la IA de precios, trae un problema nuevo de licencia de datos.

Leyenda: **[V]** verificado con fuente · **[E]** mi estimación (con su razonamiento) · **[NV]** no pude verificarlo; hay que confirmarlo a mano.

---

## TL;DR

| Pregunta | Respuesta corta |
|---|---|
| ¿El mercado alcanza? | **No, para una startup.** El GMV secundario total de Panamá [E] ronda los $0.8–2M/año. Para llegar a $10k MRR con 8% de comisión necesitarías $1.5M/año de GMV, o sea casi todo el mercado. |
| ¿Se puede cobrar comisión? | Solo en órdenes con envío y protección. En la reunión en persona pagan por Yappy/efectivo y la plataforma no ve el dinero. |
| ¿La IA de precios es el foso? | **No.** Los datos buenos (ventas de eBay, PriceCharting) **no se pueden mostrar al público sin un acuerdo comercial** [V]. La IA de reconocimiento es un commodity (Collectr, Ludex). |
| ¿NBA/NFL cambian algo? | Suman un nicho pequeño [E]: menos de 2,000 coleccionistas activos. Además, el comprador serio de sports cards ya compra en eBay y el vendedor serio ya vende ahí. |
| **Veredicto** | **NO-GO como startup. PIVOT posible** a un servicio de confianza (consignación y verificación) como ingreso extra, **o** vender a las tiendas TCG como clientes de Pedidito. |

---

## 0.1 Análisis de competidores

### Comisiones de referencia (verificadas)

| Plataforma | Comisión al vendedor | Fuente |
|---|---|---|
| eBay (trading cards) | 13.25% hasta $7,500 + $0.30–0.40 por orden; 50% de descuento en cartas de $1,000+ | [V] [eBay seller fees](https://www.ebay.com/sellercenter/selling/start-selling-on-ebay/seller-fees), [tcgfeecalc](https://tcgfeecalc.com/ebay) |
| TCGplayer | 10.75% (subió desde 10.25% en feb-2026) + 2.5% + $0.30 de procesamiento; tope de $75 por producto | [V] [TCGplayer Fees](https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees) |
| Cardmarket | 5% vendedor privado, 3% profesional, 1.5% powerseller; tope de €100 por artículo | [V] [Cardmarket Fee Table](https://www.cardmarket.com/en/Policies/Fees) |
| Whatnot | 8% + 2.9% + $0.30; 0% de comisión sobre la porción arriba de $1,500 en ciertas categorías | [V] [Whatnot Help](https://help.whatnot.com/hc/en-us/articles/4847069165965-Whatnot-seller-fees) |

**Conclusión:** la comisión "total" del mercado va de ~5% (Cardmarket) a ~13% (eBay). En Panamá, contra el 0% de WhatsApp, cualquier cifra arriba de ~5% empuja a los usuarios a cerrar el trato por fuera.

### Plataforma por plataforma

**eBay**
- *Modelo:* comisión por venta (arriba).
- *Confianza:* Money Back Guarantee y **Authenticity Guarantee** para cartas de $250+, con autenticación física por un tercero (PSA) antes de enviar al comprador. [conocimiento general; no lo revisé hoy]
- *Cold start:* no aplica; es el incumbente global desde los 90.
- *Quejas:* comisiones altas, compradores que abusan de los reclamos, envío internacional caro.
- *Qué robar:* **los "sold listings" como fuente de verdad del precio**. Aquí hay un problema: la API de ventas cerradas (Marketplace Insights) está **cerrada a nuevos desarrolladores** [V] ([eBay community](https://community.ebay.com/t5/RESTful-Sell-APIs-Marketing/Marketplace-Insight-API-responded-with-Access-denied/td-p/35066691), [SoldComps](https://sold-comps.com/alternatives)).

**TCGplayer** (de eBay)
- *Modelo:* listados atados a un **catálogo**. El vendedor no crea la carta, solo elige "esta carta, esta condición, este precio". Así se genera un **Market Price** confiable.
- *Confianza:* niveles de vendedor y programa Direct (TCGplayer recibe, verifica y reenvía).
- *Qué robar:* **el catálogo como columna vertebral**. Resuelve búsqueda, precios y fraude de golpe. Para Pokémon se puede armar gratis (pokemontcg.io). Para NBA/NFL no hay un catálogo gratuito equivalente, y eso es un costo real.

**Cardmarket**
- *Modelo:* comisión baja (5%/3%/1.5%) compensada con volumen en toda Europa.
- *Confianza:* escala estandarizada de condición (MT/NM/EX/GD…), reputación del vendedor, pago retenido por la plataforma hasta que el comprador confirma que recibió.
- *Qué robar:* **fondos retenidos hasta confirmar la recepción** y la **escala de condición explícita**.

**Whatnot**
- *Modelo:* ventas en vivo, subastas y *box breaks*.
- *Cold start:* sembró con vendedores grandes que ya tenían audiencia y les dio incentivos.
- *Qué robar:* **la venta es entretenimiento**. En Panamá los breaks por Instagram Live ya existen informalmente [E/NV].

**StockX / Alt / Courtyard / Fanatics Collect**
- *Modelo:* bóveda y liquidez instantánea para cartas graded (la carta nunca sale de la bóveda; se tokeniza o se registra).
- *Confianza:* la plataforma custodia el activo físico.
- *Qué robar:* nada para el MVP. La bóveda requiere capital, seguro y volumen. **Fuera del alcance.**

**Apps de precio y portafolio: Collectr, PriceCharting, Card Ladder, Ludex, 130point**
- Ya ofrecen escaneo por foto y precio de mercado, gratis o por pocos dólares al mes.
- **PriceCharting:** la API exige la suscripción "Legendary", y los datos **no pueden mostrarse a terceros sin un acuerdo comercial por escrito** [V] ([Terms](https://www.pricecharting.com/page/terms-of-service), [API docs](https://www.pricecharting.com/api-documentation)).
- *Implicación:* el "valor estimado con IA" **no es un diferenciador**. El usuario ya lo tiene gratis en su teléfono, y nosotros no tenemos derecho a republicar esos datos sin negociar.

**Incumbente real: Encuentra24, Facebook Marketplace, grupos de WhatsApp/IG y tiendas locales**
- **Tiendas verificadas [V]:**
  - [Trade Card Company](https://www.tradecardcompany.com/): singles desde $1, sellado de $85 a $200, pago por **Yappy**, transferencia o efectivo, delivery gratis en la ciudad desde $20 y envío a provincias en 1–2 días.
  - [Korasama](https://www.korasama.com/categoria-producto/tcg-korasama-panama/pokemon-tcg-panama/): tienda física y online.
  - [Panama Poké Center](https://www.panamapokecenter.com/)
  - [Titán](https://titan.com.pa/collections/cartas-pokemon-panama): Pokémon y Topps deportivo, con recogida en Albrook.
  - Cuenta de IG [@panamasportscards](https://www.instagram.com/panamasportscards/).
  - La evaluación de ayer contó **8+ tiendas**.
- **Cómo se compra y vende hoy [E]:** grupos de FB/WhatsApp, fotos y "DM", pago por Yappy, entrega en un mall o por delivery. Las tiendas ya resuelven la parte de "confianza" para el sellado.
- **Frustraciones probables [E/NV]:** réplicas, cartas en peor condición que en la foto, compradores que no llegan, adivinar el precio. **Hay que validarlas con 10 entrevistas; no las asumas.**
- **No pude verificar [NV]:** el volumen de anuncios en Encuentra24 (devolvió 403) ni el tamaño de los grupos de FB (requieren login). **Tarea manual para ti:** contar anuncios de "pokemon", "prizm" y "topps" en Encuentra24 y FB Marketplace durante 7 días.

---

## 0.2 Las preguntas difíciles

### 1. Tamaño de mercado en Panamá [E]

Supuestos (todos son estimaciones y deben validarse):
- Población ~4.5M, de la cual ~2M está en el área metropolitana.
- Coleccionistas/jugadores **activos** de Pokémon TCG (gastan ≥$20/mes): **3,000–8,000**. Base: 8+ tiendas que viven del producto, cada una con cientos de clientes recurrentes que se solapan entre tiendas.
- Coleccionistas activos de NBA/NFL: **500–2,000**. En Panamá el deporte de cartas natural es el béisbol (MLB/Topps), no la NFL. La NBA tiene fans, pero la cultura de "hobby box" es chica.
- Gasto **en mercado secundario** (singles o graded entre personas, no sellado de tienda): ~$150–300 por coleccionista al año.

| Escenario | Coleccionistas | GMV secundario total/año | Si capturas 15% en el año 1 | Ingreso al 8% |
|---|---|---|---|---|
| Bajo | 3,500 | ~$0.5M | $79k | **$6.3k/año** |
| Medio | 6,500 | ~$1.3M | $195k | **$15.6k/año** |
| Alto | 10,000 | ~$3M | $450k | **$36k/año** |

**Lectura honesta:** incluso en el escenario alto, el ingreso del año 1 es de **~$3k/mes**. Tu meta de $10k MRR exigiría ~$1.5M de GMV **protegido y con comisión** al año, y eso equivale a prácticamente todo el mercado secundario del país pasando por tu checkout. No es realista.

**Presión adicional:** comprar en EE.UU. es barato. Los paquetes de menos de **$100 CIF entran sin impuestos** [V] ([Zonos](https://zonos.com/es/docs/guides/country-guides/panama)). Un comprador de Panamá puede ir directo a eBay o TCGplayer con un courier (Airbox, etc.). El mercado local compite contra el inventario global.

### 2. Riesgo de desintermediación (el problema central)

En clasificados locales, comprador y vendedor se ven en persona y pagan por Yappy. La plataforma nunca toca el dinero.

| Opción | ¿Captura dinero? | Problema |
|---|---|---|
| Escrow y pago dentro de la app con protección | Sí | Requiere una pasarela que retenga fondos y pague a terceros (ver punto 5), y el usuario tiene que valorar la protección más que el 0% de WhatsApp |
| Comisión solo en órdenes enviadas y protegidas | Sí, en una fracción | Probablemente <30% de las transacciones [E]; el resto se cierra en persona |
| Suscripción de vendedor o anuncios destacados | Sí | Solo pagan tiendas y vendedores grandes, y eso es un techo de ~20–40 pagadores [E] |
| Tarifa de verificación o autenticación | Sí | Requiere expertise humano (tuyo o de un socio); no escala, pero **es donde está el valor real** |
| Híbrido | — | El más realista, pero suma ingresos chicos |

**Recomendación (si se construyera):** híbrido con **listados gratis**, **comisión de 5–6% solo en "Compra Protegida"** (con envío o entrega verificada, pago retenido hasta confirmar) y **$5–15 de verificación en persona** para cartas de más de $50. Ni así llega al volumen necesario (punto 1).

### 3. Cold start: primeros 100 anuncios y 50 transacciones

Los 100 anuncios son fáciles: cargas el inventario de 2–3 tiendas o lo cargas tú mismo. **Las 50 transacciones son el reto**, porque las tiendas ya venden por su cuenta con Yappy y delivery; tu plataforma sería un canal más, sin compradores propios. Tácticas: presencia en torneos de las ligas Play! Pokémon locales, alianza con los organizadores y breaks en vivo. **Todas se pueden probar sin código** (punto 7).

### 4. Confianza y falsificaciones

- **MVP:** verificación en persona (tú o un socio) con lupa, luz y prueba de textura para Pokémon. Punto de encuentro seguro (mall o tienda aliada). Reputación simple (calificación y número de ventas). Retención de pago hasta confirmar.
- **Después:** detección con IA de fotos robadas (búsqueda inversa) y de precios anómalos contra el catálogo.
- **Sports cards alteradas o recortadas:** son muy difíciles de detectar por foto. Para cartas caras la única respuesta seria es la **graduación de PSA/BGS/SGC**. Desde Panamá eso implica enviar a EE.UU. con semanas de espera. Un "servicio de envío a PSA en lote" sí es un servicio con valor, pero con poco volumen.

### 5. Pagos en Panamá

| Opción | Estado | Nota |
|---|---|---|
| **Stripe** | **No disponible** para empresas panameñas [V] ([Stripe global](https://stripe.com/global), [Dodo Payments](https://dodopayments.com/blogs/stripe-supported-countries-alternatives)) | Solo con una LLC en EE.UU. y cobrando en USD a tarjetas. Añade complejidad legal y no incluye Yappy |
| **Tilopay** | Opera en Panamá como facilitador de pagos y deposita en cualquier banco panameño [V] ([Tilopay PA](https://connect.tilopay.com/es-pa/tilopay-llega-a-panama-una-nueva-opcion-para-procesar-pagos-online/)) | No encontré tarifas publicadas para PA ni funciones de *split* o marketplace [NV] |
| **PagueloFacil** | Pasarela local sin afiliación ni mensualidad, solo comisión por transacción [V] ([TuComunidad](https://tucomunidad.com.pa/2020/06/afiliese-totalmente-gratis-paguelofacil-agiliza-el-comercio-electronico/)) | No encontré el % publicado [NV] |
| **Yappy Comercial** | Es lo que usa todo el mundo | Paga al comercio, no permite retener ni dividir el pago. Un "escrow" con Yappy = recibes tú y luego transfieres tú |

**El flujo tipo escrow más simple y cumplidor:** el comprador paga por Yappy Comercial o Tilopay **a la cuenta de tu empresa**. Tú retienes el dinero hasta la confirmación y le pagas al vendedor por ACH o Yappy menos la comisión. **Riesgo [NV]:** custodiar fondos de terceros puede rozar la regulación de la Superintendencia de Bancos. A escala pequeña, lo más probable es que se trate como intermediación comercial ("tú compras y revendes", es decir, consignación), pero **hay que confirmarlo con un abogado antes de retener dinero ajeno.**

### 6. Legal e impuestos (solo lo que importa para el MVP)

- **Aviso de Operación** (Panamá Emprende): necesario para facturar y para Yappy Comercial o una pasarela a nombre de empresa.
- **ITBMS 7%** sobre tu comisión (es un servicio) [V] ([Alegra](https://blog.alegra.com/panama/itbms-panama/)). Verifica con un contador si aplica el umbral de exención para pequeños contribuyentes [NV].
- **Ley 81 de 2019 (protección de datos):** consentimiento para los datos personales, política de privacidad y ubicación aproximada (a nivel de barrio) de los vendedores. Costo bajo, pero hay que hacerlo.

### 7. Veredicto: **NO-GO como startup · PIVOT opcional**

**¿Por qué no cambia respecto a ayer?**
1. **NBA/NFL** suman quizá 10–25% más coleccionistas, en un nicho donde el comprador serio ya usa eBay.
2. **La IA de precios** no es un foso: Collectr y Ludex la dan gratis, y los datos buenos tienen licencia restringida.
3. **El techo matemático** (punto 1) queda muy por debajo de $10k MRR, incluso con supuestos generosos.

**Los 3 riesgos más grandes y cómo probar cada uno sin código:**

| Riesgo | Prueba más barata | Criterio de éxito (2–4 semanas) |
|---|---|---|
| **Liquidez:** no hay suficientes transacciones C2C | Contar anuncios de cartas en Encuentra24, FB Marketplace y 3 grupos de FB/WhatsApp durante 7 días | ≥150 anuncios nuevos/semana. Menos de 50 = mercado demasiado chico |
| **Desintermediación:** nadie paga por protección | **Concierge por Instagram/WhatsApp:** "Compra Protegida", tú verificas en persona y cobras 6% o $10 mínimo | ≥20 transacciones pagadas en 4 semanas |
| **Confianza:** ¿el dolor de las falsificaciones es real? | 10 entrevistas a coleccionistas en una tienda o torneo: "¿te han estafado?, ¿cuánto pagarías por verificar?" | ≥6/10 con una historia de estafa **y** disposición a pagar ≥$5 |

**PIVOT recomendado (si quieres algo en este espacio):**
- **A. Servicio de confianza/consignación** (Instagram + Yappy, sin app): verificación en persona, compra protegida y envío en lote a PSA. **Es un ingreso extra de $500–2k/mes [E], no una startup.**
- **B. Las tiendas TCG como clientes de Pedidito:** son microcomercios que ya venden por DM con Yappy, justo el ICP de Pedidito. Aprovecha el mismo conocimiento del nicho, con un producto que sí escala.

**Mi recomendación:** no construir el marketplace. Si te apasiona el nicho, corre la prueba concierge 4 semanas mientras avanzas Pedidito, y usa esas conversaciones con tiendas como pipeline de clientes de Pedidito.

---

## Fuentes

- eBay fees: https://www.ebay.com/sellercenter/selling/start-selling-on-ebay/seller-fees · https://tcgfeecalc.com/ebay
- TCGplayer fees: https://help.tcgplayer.com/hc/en-us/articles/201357836-TCGplayer-Fees
- Cardmarket fees: https://www.cardmarket.com/en/Policies/Fees
- Whatnot fees: https://help.whatnot.com/hc/en-us/articles/4847069165965-Whatnot-seller-fees
- PriceCharting terms/API: https://www.pricecharting.com/page/terms-of-service · https://www.pricecharting.com/api-documentation
- eBay Marketplace Insights restringido: https://community.ebay.com/t5/RESTful-Sell-APIs-Marketing/Marketplace-Insight-API-responded-with-Access-denied/td-p/35066691 · https://sold-comps.com/alternatives
- Stripe availability: https://stripe.com/global · https://dodopayments.com/blogs/stripe-supported-countries-alternatives
- Tilopay Panamá: https://connect.tilopay.com/es-pa/tilopay-llega-a-panama-una-nueva-opcion-para-procesar-pagos-online/
- PagueloFacil: https://tucomunidad.com.pa/2020/06/afiliese-totalmente-gratis-paguelofacil-agiliza-el-comercio-electronico/
- De minimis $100 Panamá: https://zonos.com/es/docs/guides/country-guides/panama
- ITBMS: https://blog.alegra.com/panama/itbms-panama/
- Tiendas locales: https://www.tradecardcompany.com/ · https://www.korasama.com/categoria-producto/tcg-korasama-panama/pokemon-tcg-panama/ · https://www.panamapokecenter.com/ · https://titan.com.pa/collections/cartas-pokemon-panama · https://titan.com.pa/collections/tarjetas-coleccionables-topps-de-deportes · https://www.instagram.com/panamasportscards/
