# Cómo activar el pago con Yappy

Todo está construido y probado; falta solo la cuenta de Yappy Comercial. Mientras tanto la página sigue igual: el comprador pide comprar por WhatsApp y el staff crea la orden.

## Lo que ya funciona sin Yappy (migración 0014)

- **Mi cuenta ▸ Mis compras:** el comprador ve cada compra y toca **"Ya recibí mi carta"** o **"Tengo un problema"** (reclamo con fotos).
- **Mi cuenta ▸ Mis ventas:** el vendedor toca **"Ya la entregué"** y registra el número de Yappy donde le pagamos.
- **Reloj de 3 días:** empieza cuando se marca la entrega. Si el comprador confirma o pasan los 3 días sin reclamo, la orden pasa sola a **"Pagar hoy"** en el panel de staff.
- **Panel de staff ▸ Órdenes:** secciones "Pagar hoy", "Reclamos" (con fotos) y "En curso". La base no deja pagarle al vendedor si hay un reclamo abierto o si no terminó el plazo.
- El número rojo del menú también cuenta las ventas por entregar y las compras por confirmar.

## Pasos para activar el pago en línea

1. **Registrar la empresa y abrir Yappy Comercial** (Banco General). En Yappy Comercial ▸ Botón de pago, crear el botón con el dominio `https://rmunoz1809.github.io` (o el dominio propio si lo compran). Ahí se obtienen el **ID del comercio** y la **clave secreta**.
2. **Guardar los datos como secretos de Supabase** (nunca en el chat, en la página ni en GitHub). Lo hace un socio en Supabase ▸ Edge Functions ▸ Secrets:
   - `YAPPY_MERCHANT_ID`
   - `YAPPY_SECRET_KEY`
   - `YAPPY_DOMAIN` = el mismo dominio del paso 1
   - `YAPPY_ENV` = `pruebas` primero
   - `YAPPY_TEST_PHONE` = el número inscrito en el programa de pruebas de Yappy
3. **Publicar la función** (una sola vez):
   `supabase functions deploy yappy-pago --no-verify-jwt --use-api --project-ref vqcpqoedsyatxswdzqcy`
4. **Probar en el ambiente de pruebas:** en `holo.html`, poner `CONFIG.YAPPY.ENABLED = true` y `CDN` con la dirección de pruebas (está en el comentario). Hacer una compra de prueba y revisar que la orden pase a "Pagada" sola en el panel.
   Dos cosas a confirmar en esa prueba, porque la documentación de Yappy no las detalla: que `paymentDate` acepte el `epochTime` que devuelve Yappy, y si en producción hace falta `aliasYappy`.
5. **Pasar a producción:** `YAPPY_ENV = produccion`, quitar `YAPPY_TEST_PHONE`, dejar el `CDN` de producción y publicar la página.

## Lo que sigue siendo manual

**Pagarle al vendedor.** El Botón de Pago de Yappy solo cobra; no envía dinero a terceros. El panel muestra en "Pagar hoy" el Yappy y el monto de cada vendedor: se transfiere desde la app de Yappy Comercial y se toca "Ya le pagué". Si Banco General ofrece pagos masivos por API, se puede automatizar después.

## Seguridad

- El monto lo calcula la base de datos (`start_checkout` y `new_payment_attempt`), nunca el navegador.
- El aviso de pago de Yappy se acepta solo con la firma HMAC válida, y solo la función (con la clave de servicio) puede marcar una orden pagada (`confirm_payment`).
- Si llega un pago para una carta que ya no estaba disponible, la orden queda marcada con "ATENCIÓN… Reembolsar" en el panel.
- Las compras sin pagar se cancelan solas 30 minutos después de vencer (tarea `holo-checkouts-vencidos` en pg_cron) para no bloquear la carta.
