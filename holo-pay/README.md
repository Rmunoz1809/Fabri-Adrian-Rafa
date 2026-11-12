# holo-pay: pagos con Yappy (fase 1)

Base del flujo de pagos de Holo con el Botón de Pago de Yappy. Sin catálogo completo ni login real todavía.

Stack: Next.js 16 (App Router) + TypeScript, Prisma 6 (SQLite en desarrollo, PostgreSQL en producción), zod, Vitest.

## Arrancar en local (sin Yappy real)

```bash
cd holo-pay
npm install
cp .env.example .env
npm run yappy:test-key      # pega el resultado en YAPPY_SECRET_KEY (clave de PRUEBA)
# pon una ADMIN_PASSWORD de 12+ caracteres
npx prisma db push          # crea prisma/dev.db
npm run db:seed             # 4 cartas de ejemplo
npm run dev
```

Con `YAPPY_MODE=mock` no se llama a Yappy: el mock tiene la misma interfaz que el cliente real.
Los celulares `60000005` y `60000010` simulan los errores E005 y E010.

1. Abre http://localhost:3000, elige una carta, escribe un celular (6123-4567) y toca **Pagar con Yappy**.
2. Te lleva a "Esperando tu pago en Yappy" con el número de orden (ej. `H7K2Q9ZP4M`).
3. Simula a Yappy con un IPN firmado:

```bash
npm run ipn -- H7K2Q9ZP4M E
```

   `E` pagada, `R` rechazada, `C` cancelada, `X` expirada. `--bad-signature` manda una firma inválida.
4. La pantalla cambia sola a "¡Pago recibido!". En http://localhost:3000/admin (usuario y contraseña de `.env`) ves la orden, su log de IPN y la cola de revisión.

Checks: `npm test` y `npm run typecheck`.

## Cómo funciona

| Paso | Dónde |
|---|---|
| Crear orden: valida el celular y el stock, reserva una unidad, crea la orden en `pending_payment` (vence en 6 min) y llama a Yappy. Si Yappy responde error, cancela la orden y devuelve el stock | `POST /api/orders` → `src/lib/orders/create.ts` |
| Cliente de Yappy: `validate/merchant` y luego `payment-wc` con el token. Montos en dólares con dos decimales solo aquí. Errores E005–E100 con mensaje claro | `src/lib/yappy/client.ts`, `errors.ts` |
| Pantalla de espera: consulta el estado cada 4 s. El pago se confirma solo con el IPN del servidor, nunca con una redirección | `/orden/[publicId]`, `GET /api/orders/[publicId]/status` |
| IPN: guarda el evento crudo, verifica la firma HMAC (tiempo constante), busca la orden, aplica E/R/C/X de forma atómica e idempotente, avisa al vendedor | `GET /api/yappy/ipn` → `src/lib/yappy/ipn.ts` |
| Expiración: cada minuto, las órdenes vencidas pasan a `expired` y devuelven el stock | `src/instrumentation.ts` (servidor Node) o `GET /api/cron/expire` con `Authorization: Bearer $CRON_SECRET` |
| Admin: órdenes con filtros, cola de pagos por revisar (reactivar / reembolsado / resolver), log de IPN por orden y CSV de pagadas del día | `/admin`, protegido por `src/proxy.ts` |

## Producción (pendiente)

- **Base de datos:** cambia `provider = "sqlite"` a `"postgresql"` en `prisma/schema.prisma`, pon el `DATABASE_URL` de Postgres y corre `npx prisma db push` (o migraciones).
- **Hosting:** necesita un servidor Node (Railway, Render, Fly, un VPS) o Vercel. En Vercel pon `EXPIRY_INTERVAL=off` y un cron que llame a `/api/cron/expire` cada minuto.
- **Variables:** las de `.env.example`, con `YAPPY_MODE` distinto de `mock`, la clave real de Yappy Comercial y `APP_BASE_URL` = la URL pública (Yappy manda el IPN a `APP_BASE_URL/api/yappy/ipn`). `YAPPY_DOMAIN` debe ser el dominio registrado en Yappy.
- **Rate limiting** está en memoria: sirve con una sola instancia. Con varias, muévelo a Redis o a la base.
- **Notificación al vendedor** hoy es un log (`src/lib/notify/seller.ts`); se conecta a WhatsApp o correo implementando `SellerNotifier`.
- **Reembolsos:** el botón solo marca la orden; el dinero se devuelve desde Yappy Comercial.

## Decisiones

- **Dinero en centavos enteros** en toda la app (`src/lib/money.ts`). Se convierte a dólares con dos decimales solo al mandarlo a Yappy.
- **Envío: $3** (`SHIPPING_CENTS`). Yappy no tiene campo de envío: va dentro de `subtotal` (subtotal = precio + envío; total = subtotal + impuestos). El comprador no paga ITBMS (la comisión se le cobra al vendedor), así que `taxes` = 0 por ahora.
- **Estados en inglés en el código** (regla del repo: código en inglés). Equivalencias:

  | Código | Spec |
  |---|---|
  | `pending_payment` | pendiente_pago |
  | `paid` | pagada |
  | `seller_notified` | vendedor_notificado |
  | `shipped` | enviada |
  | `delivered` | entregada |
  | `payout_released` | pago_liberado |
  | `expired` / `cancelled` / `rejected` | expirada / cancelada / rechazada |
  | `refunded` | reembolso |
  | `under_review` | en_revision |

- **Máquina de estados** en `src/lib/orders/state-machine.ts`. Ningún estado se salta. Un pago (`E`) que llega para una orden expirada, cancelada o rechazada va a `under_review`; de ahí un humano solo puede reactivar (`paid`, si hay stock) o reembolsar.
- **Una sola función cambia estados**: `transitionOrder()` (`src/lib/orders/transition.ts`). Es atómica e idempotente (`UPDATE ... WHERE status = <from>`): si el mismo cambio llega dos veces, el segundo no hace nada. Mueve el stock y el estado del anuncio en la misma transacción y guarda cada cambio en `OrderTransition`.
- **Stock**: la orden guarda `stockHeld` (si tiene una unidad reservada). Expirar, cancelar o rechazar devuelve la unidad; un reembolso antes de enviar la devuelve; después de enviada no (la carta ya salió). Reactivar un pago tardío vuelve a reservar y falla si ya no hay stock. El anuncio queda `active` mientras tenga stock, `reserved` si la última unidad espera un pago y `sold` si la última unidad está pagada.
- **PaymentEvent** guarda cada IPN crudo siempre, con su resultado (`IpnResult`): `valid`, `duplicate`, `invalid_signature`, `order_not_found`, `late_payment` (E para una orden expirada/cancelada → `under_review`), `invalid_transition` (p. ej. R después de pagada: no deshace el pago), `invalid_status`, `malformed`.
- **El IPN siempre responde 200** una vez guardado (no le dice a nadie si la firma era válida), salvo que falte la clave en el servidor.
- **`publicId`**: "H" + 9 caracteres base36 (10 en total), cumple la regla de Yappy (1–15 alfanuméricos) y es único (índice único + reintento).
- **Al pagar** se avisa al vendedor y la orden pasa sola a `seller_notified`. Si el aviso falla, queda en `paid` y aparece en la cola del admin.
