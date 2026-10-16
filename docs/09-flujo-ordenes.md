# Flujo de órdenes, pago retenido y logística

Migración `0029_escrow_orders.sql`. Reemplaza el flujo de Compra Protegida de las migraciones 0014, 0016, 0027 y 0028: el vendedor ya no entrega directo, ahora **Holo recoge la carta, la custodia y la entrega**. Toda la lógica vive en la base de datos (funciones de Postgres). La página (`holo.html`) solo llama a esas funciones.

## Estados

```
esperando_confirmacion_vendedor ─▶ pendiente_pago ─▶ pagada_retenida ─▶ esperando_entrega_vendedor
        │ (2 h sin confirmar,             │ (no pagó a tiempo,                    │ (48 h sin entregar:
        │  o el vendedor no la tiene)     │  o Yappy R/X)                         │  reembolso + penalización)
        ▼                                 ▼                                       ▼
    cancelada                          fallida                                cancelada

esperando_entrega_vendedor ─▶ en_custodia ─▶ en_camino ─▶ entregada ─▶ en_revision ─▶ completada
   │ (retiro en tienda: código)  ▲  │           │                         │ (48 h)
   └──────────────▶ entregada    │  │ incidente │ comprador ausente       ▼
                                 └──┼───────────┘                     en_disputa ─▶ completada / reembolsada
                                    ▼
                               reembolsada (devuelta al vendedor o incidente)
```

- La tabla `order_transitions` define qué cambio es válido y **quién** puede hacerlo (comprador, vendedor, admin, sistema, proveedor). Un trigger lo exige en cada cambio, incluso si el staff edita la tabla a mano.
- Cada cambio queda en `order_status_history`: estado anterior, nuevo, quién, cuándo y por qué.
- Con una **oferta aceptada**, la orden empieza en `pendiente_pago` (el vendedor ya dijo que sí).
- **Retiro en tienda** (tiendas verificadas): sin envío; la tienda escribe el código de 4 dígitos del comprador y la orden pasa directo a `entregada`.

## Montos

Todo en centavos (enteros), calculado en la base desde el anuncio. Ninguna función recibe montos del navegador.

- Comprador paga: precio (o la oferta aceptada) + envío (`holo_settings.shipping_cents`; 0 con retiro en tienda).
- Vendedor recibe: precio − comisión (5%) − ITBMS sobre la comisión (7%). Igual que antes.
- `order_quote()` en SQL y `quoteOrder()` en `src/lib/fees.ts` dan lo mismo (hay un test que lo compara).

## Libro contable (`ledger_entries`)

Partida doble: débito > 0, crédito < 0, y cada transacción suma 0. Solo se agregan filas (nadie puede editar ni borrar).

| Cuenta | Qué es |
|---|---|
| `banco` | La cuenta de Holo (Yappy Comercial) |
| `retencion` | Dinero retenido de una orden (un saldo por orden) |
| `vendedor` | Lo que Holo le debe a cada vendedor: su saldo |
| `comprador` | Reembolsos que Holo le debe a un comprador |
| `holo_comision`, `holo_itbms`, `holo_envio`, `holo_penalizaciones` | Ingresos e ITBMS por pagar |
| `fondo_reserva` | Cubre pérdidas o daños en custodia de Holo |

Movimientos: **cobro** (banco ← retención), **venta/comisión/itbms/envío** (al completarse, la retención se reparte), **reembolso** (retención → comprador, y comprador → banco cuando el admin lo paga), **liquidación** (vendedor → banco), **penalización** (vendedor → Holo) y **fondo_reserva** (fondo → vendedor).

El saldo del vendedor sale **solo** de este libro. Una orden en disputa no está completada, así que su dinero sigue retenido y no entra al saldo.

## Plazos automáticos

`run_order_deadlines()` corre cada 5 minutos (pg_cron `holo-plazos-ordenes`):

| Plazo | Ajuste | Qué pasa |
|---|---|---|
| Vendedor confirma | `seller_confirm_minutes` (120) | `cancelada`, sin cobro |
| Pago | `payment_minutes` (10) | `fallida`, la carta sigue a la venta |
| Vendedor entrega | `seller_delivery_hours` (48) | `cancelada`, reembolso completo (con envío) y penalización |
| Revisión del comprador | `review_hours` (48) | `completada`, el dinero pasa al saldo del vendedor |
| Recordatorios | `remind_confirm_minutes`, `remind_delivery_hours` | Aviso al vendedor antes de cada plazo (una vez) |

`prepare_weekly_payouts()` corre los lunes a las 8:00 (Panamá) y prepara una liquidación por vendedor con saldo.

## Penalizaciones

Por cada venta sin entregar en el período (`strike_window_days`): 1.ª advertencia y anuncios pausados (`warning_pause_days`), 2.ª suspensión (`suspension_days`), 3.ª expulsión. Las tiendas verificadas además pagan `shop_penalty_cents`, que se descuenta de su saldo. Los vendedores nuevos (no tiendas verificadas) no pueden publicar por encima de `new_seller_max_price_cents` hasta completar `new_seller_sales` ventas.

## Logística

- Al crear la orden se genera un **código de 4 dígitos** que solo ve el comprador (Mi cuenta). Tras 5 intentos fallidos se bloquea y aparece en Alertas.
- **Fotos obligatorias:** frente y reverso al recoger; al menos una al entregar. Van al bucket privado `order-photos/<id de la orden>/`.
- **Comprador ausente:** vuelve a custodia. El comprador paga `delivery_retry_cents` para un segundo intento (`#/reintento/<orden>`). Si ese también falla, se devuelve la carta al vendedor y se reembolsa todo menos el envío.
- **Incidentes** (pérdida, daño, accidente, robo) con responsable y monto cubierto, hasta `incident_max_cents` por envío. Si la carta estaba en manos de Holo: reembolso total al comprador y pago al vendedor desde el fondo de reserva.

## Reembolsos y liquidaciones (manuales por ahora)

El sistema crea la solicitud (destinatario, monto, motivo) y la mueve en el libro. El admin paga por Yappy y la marca como pagada con la referencia (`#/admin?tab=pagos`). La liquidación semanal se exporta a CSV.

## Panel de staff

`#/admin`: **Órdenes** (por estado, con historial, fotos, pagos, avisos de Yappy y libro de cada orden), **Disputas**, **Reembolsos y liquidaciones**, **Conciliación y alertas** (cobrado por día y alertas de órdenes atascadas, compradores y vendedores repetidos y códigos bloqueados) y **Ajustes** (todos los valores de `holo_settings`).

## Probar en local

No hace falta Supabase ni Docker: las pruebas corren todas las migraciones en PGlite (Postgres en WASM).

```bash
export PATH="$HOME/.local/node/bin:$PATH"
npm test              # incluye src/lib/escrow/*.test.ts
npm run demo:flujo    # recorre una compra completa con el mock de Yappy e imprime historial y libro
```

`supabase/seed_escrow.sql` crea un staff, una tienda verificada (Cartas Panamá), una vendedora particular (Ana), un comprador (Beto) y 5 anuncios. **Úsalo solo en una base local o de prueba.**

Para probar la página con el mock en un proyecto de Supabase de pruebas: aplica la migración 0029 (y el seed), publica `yappy-pago` con `PAYMENT_PROVIDER=mock`, `MOCK_PAYMENT_SECRET` (base64 de `clave.loquesea`), `YAPPY_DOMAIN` y `PAYMENT_DEV_SIMULATOR=true`, y en `holo.html` pon `CONFIG.YAPPY.ENABLED = true` y `SIMULATOR = true`. El checkout muestra botones E/R/C/X en vez del botón de Yappy.
