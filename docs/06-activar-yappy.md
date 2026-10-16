# Cómo activar el pago con Yappy

Todo está construido y probado con un **mock de Yappy**; falta solo la cuenta de Yappy Comercial. Mientras tanto la página sigue igual: el comprador pide comprar por WhatsApp y el staff crea la orden. El flujo completo (confirmación del vendedor, retención, custodia, entrega con código, disputas, reembolsos y liquidaciones) está en `docs/09-flujo-ordenes.md` (migración 0029).

## Proveedor de pago

La Edge Function `yappy-pago` usa la interfaz `PaymentProvider` (`supabase/functions/_shared/payments/`):

- `PAYMENT_PROVIDER=mock`: imita el Botón de Pago Yappy V2 (mismo formato de `orderId`, IPN por GET con `orderId`, `status`, `hash` y `domain`, estados E/R/C/X y la misma firma). Necesita `MOCK_PAYMENT_SECRET` y `YAPPY_DOMAIN`. Con `PAYMENT_DEV_SIMULATOR=true` la página puede simular E/R/C/X (`CONFIG.YAPPY.SIMULATOR = true` en `holo.html`). **Nunca en producción.**
- `PAYMENT_PROVIDER=yappy` (por defecto): el botón real, con los secretos de abajo.

Cada aviso (IPN) se verifica (firma HMAC-SHA256 con la primera parte de la clave decodificada, comparada en tiempo constante, y que el dominio sea el de Holo), se registra en `payment_notifications` (también los inválidos) y se procesa **una sola vez** aunque llegue repetido.

## Pasos para activar el pago en línea

1. **Registrar la empresa y abrir Yappy Comercial** (Banco General). En Yappy Comercial ▸ Botón de pago, crear el botón con el dominio `https://rmunoz1809.github.io` (o el dominio propio si lo compran). Ahí se obtienen el **ID del comercio** y la **clave secreta**.
2. **Guardar los datos como secretos de Supabase** (nunca en el chat, en la página ni en GitHub). Lo hace un socio en Supabase ▸ Edge Functions ▸ Secrets:
   - `YAPPY_MERCHANT_ID`
   - `YAPPY_SECRET_KEY`
   - `YAPPY_DOMAIN` = el mismo dominio del paso 1
   - `YAPPY_ENV` = `pruebas` primero
   - `YAPPY_TEST_PHONE` = el número inscrito en el programa de pruebas de Yappy
3. **Aplicar la migración 0029 y publicar la función** (una sola vez; `PAYMENT_PROVIDER` sin poner o `yappy`):
   `supabase functions deploy yappy-pago --no-verify-jwt --use-api --project-ref vqcpqoedsyatxswdzqcy`
4. **Probar en el ambiente de pruebas:** en `holo.html`, poner `CONFIG.YAPPY.ENABLED = true` y `CDN` con la dirección de pruebas (está en el comentario). Hacer una compra de prueba y revisar que la orden pase a "Pagada" sola en el panel.
   Dos cosas a confirmar en esa prueba, porque la documentación de Yappy no las detalla: que `paymentDate` acepte el `epochTime` que devuelve Yappy, y si en producción hace falta `aliasYappy`.
5. **Pasar a producción:** `YAPPY_ENV = produccion`, quitar `YAPPY_TEST_PHONE`, dejar el `CDN` de producción y publicar la página.

## Lo que falta confirmar con Yappy real

- Que `paymentDate` acepte el `epochTime` que devuelve Yappy y si en producción hace falta `aliasYappy` (prueba del paso 4).
- **Consultar el estado de un cobro:** el Botón de Pago V2 no documenta un endpoint de consulta; `YappyProvider.getStatus()` responde "unknown" y el IPN es la única fuente. Si Banco General da uno, se implementa ahí.
- **Cuánto tarda Yappy en marcar `R`** (la documentación dice 5 minutos). El plazo de pago de Holo es `payment_minutes` (10) en Panel ▸ Ajustes.
- **Reintentos del IPN:** si la función responde 500, ¿Yappy reintenta? El proceso es idempotente, así que no hay riesgo, pero conviene saberlo.

## Lo que sigue siendo manual

**Reembolsos y pagos a vendedores.** El Botón de Pago de Yappy solo cobra; no envía dinero a terceros. El sistema crea cada reembolso y la liquidación semanal de cada vendedor (Panel ▸ Reembolsos y liquidaciones, exportable a CSV); se transfiere desde la app de Yappy Comercial y se marca como pagado con la referencia. Si Banco General ofrece pagos masivos por API, se puede automatizar después.

## Seguridad

- El monto lo calcula la base de datos (`request_order`, `staff_create_order` y `new_payment_attempt`), nunca el navegador.
- El aviso de pago de Yappy se acepta solo con la firma HMAC válida y el dominio de Holo, y solo la función (con la clave de servicio) puede marcar una orden pagada (`process_payment_notification`).
- Si llega un pago para una carta que ya no estaba disponible, o un pago tarde o repetido, se crea el reembolso solo.
- Las compras sin pagar se cierran solas al vencer el plazo de pago (tarea `holo-plazos-ordenes` en pg_cron, cada 5 minutos) para no bloquear la carta.
