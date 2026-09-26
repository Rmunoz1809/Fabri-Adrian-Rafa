# Análisis de mejoras de Holo

**Fecha:** 2026-09-26 · **Base:** estado de `main` en `171097a`: `holo.html` (1,314 líneas, 173 KB), app Next.js en `src/`, Supabase.

**Criterio para priorizar:** nuestra meta es **≥20 Compras Protegidas pagadas en las primeras 4 semanas** después de lanzar ([02-product-spec](02-product-spec.md)). Cada mejora se juzga por cuánto nos acerca a poder medir y cumplir esa meta.

---

## Diagnóstico en una línea

La app se ve bien y ya tiene lo difícil (catálogo, precio estimado, gráfica con fuentes reales, publicación con fotos). Lo que falta es **la parte que genera ingresos**: hoy **nadie puede hacer una Compra Protegida** y **no medimos nada**.

---

## P0: bloquean la validación (hacer antes de lanzar)

### 1. La Compra Protegida no se puede usar
- `CONFIG.WHATSAPP` está vacío, así que los botones "Comprar protegido" y "Preguntar por WhatsApp" no funcionan.
- `protected_eligible` solo lo puede activar un staff y **no hay pantalla de staff**, así que ningún anuncio real muestra la opción.
- **Qué hacer:**
  - Poner el número de la plataforma.
  - Activar la protección automáticamente en cartas de $25 o más del área metropolitana (trigger en Supabase).
  - Crear un **panel mínimo de staff** en `#/admin` para registrar cada orden: pagada → verificando → entregada → liberada o reembolsada. La tabla `protected_orders` ya existe.
- **Esfuerzo:** 1 día.

### 2. No medimos nada
- No hay ninguna analítica. En 4 semanas no vamos a saber si hubo 50 visitas o 5,000, ni en qué paso se cae la gente.
- **Qué hacer:** una tabla `events` en Supabase (solo insertar, sin datos personales) con 6 eventos: `visita`, `ver_carta`, `click_whatsapp`, `click_protegida`, `publicar`, `registro`. Alternativa: Umami o Plausible, que no usan cookies y no requieren banner.
- **Por qué importa:** el embudo visita → ver carta → click protegida → pago es exactamente lo que decide si seguimos.
- **Esfuerzo:** medio día.

### 3. Dos apps que se están separando
- Los tres trabajamos en `holo.html`: la gráfica, el login nuevo y la publicación en dos pasos solo existen ahí. La app Next.js (`src/`) no tiene nada de eso.
- Mantener las dos ya nos costó un choque (el de `price_snapshots`), y cada función nueva habría que hacerla dos veces.
- **Propuesta:** durante la validación, **`holo.html` es la app oficial** y la app Next.js queda congelada.
- **Lo único que se pierde es la IA por foto,** porque necesita una clave secreta. Solución: moverla a una **Supabase Edge Function** que guarda la clave del lado del servidor. Así `holo.html` también identifica cartas con foto, sin exponer nada.
- **Esfuerzo:** 1 día para la Edge Function. **Esta decisión la tenemos que tomar los tres.**

---

## P1: confianza y crecimiento (primeras 2 semanas)

### 4. Botón "Compartir" con imagen
- Nuestra distribución real son los **grupos de Facebook, WhatsApp e Instagram**. Hoy un link a una carta (`holo.html#/carta/…`) se ve en WhatsApp sin foto ni precio: las rutas con `#` y GitHub Pages no generan vista previa.
- **Qué hacer:** un botón que genere una **imagen lista para compartir** (foto de la carta, precio, rango estimado y "holo.pa"), con `navigator.share` en el celular. Así cada vendedor se vuelve un canal de difusión.

### 5. Foto de verificación
- Es la práctica estándar en las comunidades de intercambio de cartas: una foto de la carta junto a un papel escrito a mano con "HOLO + la fecha". Demuestra que el vendedor la tiene físicamente y descarta las fotos robadas de internet.
- Es barato de implementar (una foto obligatoria más y una etiqueta "Verificada con foto") y ataca el miedo número uno del comprador.

### 6. "Marcar como vendida" con precio final
- Los precios de ventas en Panamá son el **único dato que nadie más tiene**. Hoy la tabla `sales` solo la puede escribir staff, y no hay botón para hacerlo.
- **Qué hacer:** cuando el vendedor marque su anuncio como vendido, pedirle el precio final. Ese dato alimenta la estimación local (se necesitan 3 o más ventas por carta) y la gráfica de Rafa.

### 7. Reportar anuncio y perfil de vendedor
- Las tablas `reports` y `reviews` existen pero no tienen pantalla.
- **Qué hacer:**
  - Un botón "Reportar" en cada anuncio (réplica, estafa, precio falso).
  - Una página de perfil (`#/vendedor/:id`) con los anuncios y reseñas del vendedor.

---

## P2: cuando haya tráfico

| # | Idea | Por qué |
|---|---|---|
| 8 | **"Busco…"**: el comprador publica lo que quiere y recibe un aviso cuando alguien lo publica | Genera oferta a partir de la demanda y mide qué cartas se buscan en Panamá |
| 9 | **Carga masiva para tiendas** (lista de cartas del catálogo + precio) | Con 2 o 3 tiendas se llenan los primeros 100 anuncios en una tarde |
| 10 | **"Hacer oferta"**: un mensaje prearmado de WhatsApp con el monto | Regatear es la norma local; hoy solo hay precio fijo |
| 11 | **Editar anuncio** y vencimiento a los 30 días | Evita anuncios muertos, que matan la confianza en un marketplace nuevo |

## Antes de abrir al público (checklist)

- [ ] **Correo propio** (Resend u otro SMTP) y volver a activar la confirmación de email.
- [ ] **Captcha en el registro** (Turnstile o hCaptcha; Supabase los trae).
- [ ] **Páginas de Términos y Privacidad** (Ley 81 de 2019) y **reglas de Compra Protegida**: plazo de reembolso, qué pasa si la carta no coincide y cómo se resuelve una disputa.
- [ ] **Apagar los anuncios de ejemplo** (`SHOW_DEMO_LISTINGS: false`).
- [ ] **Rotar las claves** que se compartieron por chat: la API key de Anthropic y el token de GitHub.

## Deuda técnica a vigilar

- **Precios incrustados en `holo.html`:** hoy son 84 KB con 5 cartas y crecen con cada carta nueva. Con unas 300 cartas el HTML pasaría de 1 MB [estimado] y cargaría lento en celular. Cuando llegue a unos 500 KB, conviene cargar `data/precios.json` solo al abrir una carta, en vez de incrustarlo en el HTML.
- **`price_snapshots.sql` quedó instalado en Supabase** y su tarea diaria (pg_cron, 6:15 UTC) corre, pero `CONFIG.PRICE_SNAPSHOTS` está en `false`, así que nadie usa esos datos. Hay que decidir: activarlo en `holo.html` o quitar la tarea con `select cron.unschedule('holo-precios-diarios');`.
- **La búsqueda en Supabase distingue acentos:** buscar "pokemon" no encuentra "Pokémon" en anuncios reales. Se arregla con la extensión `unaccent`.

## Lo que NO haría todavía

- App nativa, pagos automáticos con pasarela, chat propio, subastas o breaks en vivo. Ninguno ayuda a conseguir las primeras 20 Compras Protegidas, y todos cuestan semanas.

---

## Plan sugerido (2 semanas)

| Día | Qué | Quién (propuesta) |
|---|---|---|
| 1 | Decidir el punto 3 (¿`holo.html` es la app oficial?), poner el número de WhatsApp y activar la regla automática de protección | Los tres |
| 1–2 | Panel de staff + analítica | Fabri + Claude |
| 3–4 | Botón compartir + foto de verificación | Adrián (diseño) |
| 3–5 | Marcar como vendida + reportar + perfil de vendedor | Rafa |
| 5–6 | IA por foto en una Edge Function | Fabri + Claude |
| 7 | Términos, captcha, correo; apagar los ejemplos | Los tres |
| 8–14 | **Lanzamiento:** 2 o 3 tiendas cargan inventario + un torneo local + grupos de Facebook y WhatsApp. Revisar el embudo cada 2 días | Los tres |

---

## Revisión de calidad (2026-09-26, versión `fb9cd6f`)

**Corregido en esta revisión:**
- 🔴 **Costo sin límite en la investigación de precios** (`identificar-carta`, acción `price`). Funcionaba sin sesión y con nombres de carta enviados por el navegador, así que cualquiera podía repetir búsquedas web pagadas en bucle. Ahora exige sesión y tiene un tope de 100 investigaciones nuevas cada 24 h, guardado en la base de datos (`PRICE_DAILY_MAX`). Los precios ya investigados se siguen mostrando desde el caché.
- 🔴 **Inyección de HTML** con los nombres de las fuentes de precio que vienen de la web. Ahora se limpian y solo se aceptan links `http(s)`.
- 🟡 **Desborde horizontal en celulares de 320 px:** el botón del inicio y el selector Tiendas/Particulares.

**Sin errores:** todas las rutas (inicio con filtros, detalle, vender, cuenta, admin, protegida, 404), sin errores de JavaScript. Tampoco se pudo inyectar código por la URL de búsqueda.

**Pendiente de acción:**
1. Correr `0008_market_quotes.sql` y **publicar la función `identificar-carta` nueva**. Mientras tanto, la página pide precios a la versión vieja y la gráfica de graduadas y deportivas muestra "reintentar".
2. Poner un **límite de gasto en Anthropic**. La investigación de precios usa búsqueda web, que es más cara que identificar una foto: unos $0.05–0.15 por carta nueva [estimado].

**Mejoras recomendadas (por impacto):**

| # | Mejora | Por qué |
|---|---|---|
| 1 | **Permitir mirar sin cuenta** (pedir cuenta solo para publicar, contactar o comprar) | Hoy todo está detrás del login: el link que alguien comparte por WhatsApp abre la pantalla de entrada, no la carta. Esto frena justo la difusión que queremos al lanzar |
| 2 | **Búsqueda sin acentos en anuncios reales** (extensión `unaccent`) | "pokemon" no encuentra "Pokémon" en anuncios reales (los de ejemplo sí) |
| 3 | **Revisar el uso de precios de PriceCharting y eBay** | Sus términos restringen mostrar sus datos. Mostrarlos como referencia con link a la fuente reduce el riesgo, pero conviene revisarlo antes de crecer |
| 4 | **Reseñas de vendedores** después de cada Compra Protegida liberada | La tabla `reviews` ya existe y da confianza a partir de las primeras ventas |
| 5 | **"Busco…"** con avisos | Genera oferta a partir de la demanda y mide qué se busca en Panamá |
| 6 | **Decidir el destino de la app Next.js (`src/`)** | Ya no se usa en producción y se está quedando desactualizada |

**Orden:**
- Hay dos migraciones `0002_*`. En adelante, revisar el último número antes de crear una nueva.
- El commit de precios web menciona "migración 0007", pero el archivo es `0008`.
- La tarea diaria de `price_snapshots.sql` (pg_cron) corre pero nadie la usa (`PRICE_SNAPSHOTS: false`): activarla o quitarla.
