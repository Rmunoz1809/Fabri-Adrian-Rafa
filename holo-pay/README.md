# holo-pay: pagos con Yappy (fase 1)

Base del flujo de pagos de Holo con el Botón de Pago de Yappy. Sin catálogo completo ni login real todavía.

Stack: Next.js 16 (App Router) + TypeScript, Prisma 6 (SQLite en desarrollo, PostgreSQL en producción), zod, Vitest.

## Arrancar

```bash
cd holo-pay
npm install
cp .env.example .env   # y llena las variables (nunca subas .env)
npx prisma db push     # crea prisma/dev.db
npm run dev
```

Checks: `npm test` y `npm run typecheck`.

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
- **PaymentEvent** guarda cada IPN crudo siempre, con su resultado (`IpnResult`).
