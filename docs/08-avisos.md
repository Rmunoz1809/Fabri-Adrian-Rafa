# Avisos (campanita y correo)

## Qué ya funciona (migración 0021)

Cada evento importante crea un aviso en la base de datos, sin depender del navegador de nadie:

| Para quién | Cuándo |
|---|---|
| Vendedor | Nueva oferta · aceptaron o rechazaron su contraoferta · **vendió una carta (ya pagaron)** · el comprador confirmó · el comprador reportó un problema · el reclamo se resolvió a su favor · **le pagamos** · la venta se reembolsó · recibió una reseña |
| Comprador | Le contraofertaron · aceptaron o rechazaron su oferta · recibimos su pago · **marcaron su carta como entregada (3 días para revisar)** · resultado de su reclamo · le devolvimos el dinero · pedido de reseña |
| Tienda | Su tienda quedó verificada |
| Quien pidió una Revisión en tienda | Pago recibido y resultado |
| Plan Coleccionista | Plan activado o renovado |
| Staff (todos) | Orden pagada · reclamo nuevo |

En la página: la **campanita** del encabezado muestra cuántos avisos sin leer hay (se revisa cada minuto y cuando la persona vuelve a la pestaña), y `#/avisos` los lista. En Mi cuenta cada persona puede apagar los correos.

## Activar los correos

Hace falta un **dominio propio** (por ejemplo `holo.com.pa` o `holopanama.com`): los servicios de correo no dejan enviar a cualquier persona desde una dirección de Gmail ni desde `github.io`. El dominio también sirve después para la página y para Yappy.

1. **Comprar el dominio** (unos $10–15 al año).
2. **Crear una cuenta en [Resend](https://resend.com)** (gratis hasta 3,000 correos al mes) y **verificar el dominio** (Resend da 3 registros DNS para copiar en el proveedor del dominio).
3. **Guardar los secretos en Supabase** ▸ Edge Functions ▸ Secrets (nunca en el chat, en la página ni en GitHub):
   - `RESEND_API_KEY`: la clave de Resend
   - `EMAIL_FROM`: por ejemplo `Holo <avisos@tudominio.com>`
   - `SITE_URL`: `https://rmunoz1809.github.io/Fabri-Adrian-Rafa/holo.html` (o la dirección nueva)
   - `CRON_SECRET`: un texto largo al azar (por ejemplo, generado con un gestor de contraseñas)
4. **Publicar la función**:
   `supabase functions deploy enviar-avisos --no-verify-jwt --use-api --project-ref vqcpqoedsyatxswdzqcy`
5. **Programar el envío cada 2 minutos.** En Supabase ▸ SQL Editor, reemplazando `PEGAR_CRON_SECRET` por el mismo texto del paso 3 (escríbelo directo ahí, no lo pegues en el chat):
   ```sql
   select cron.unschedule('holo-enviar-avisos') where exists (select 1 from cron.job where jobname = 'holo-enviar-avisos');
   select cron.schedule('holo-enviar-avisos', '*/2 * * * *', $cron$
     select status from extensions.http((
       'POST', 'https://vqcpqoedsyatxswdzqcy.supabase.co/functions/v1/enviar-avisos',
       array[extensions.http_header('x-cron-secret', 'PEGAR_CRON_SECRET')], 'application/json', '{}'
     )::extensions.http_request)
   $cron$);
   ```
6. **Encender el aviso en la página:** en `holo.html`, `CONFIG.EMAIL_ALERTS = true` (quita el texto "empiezan a llegar pronto").
7. **Probar:** hacer una oferta a una carta de otra cuenta y revisar que llegue el correo en 2–3 minutos.

**Cómo envía:** junta los avisos nuevos de cada persona en un solo correo por vuelta (máximo 10), con un botón "Ver en Holo". Los avisos de más de un día no se envían (así, al activarlo no llega una avalancha de avisos viejos). Si Resend falla, reintenta hasta 3 veces.

## Después

- **WhatsApp:** la API de WhatsApp Business cobra por mensaje y necesita la empresa registrada y un número propio. Conviene solo para lo urgente (vendiste, entrega, pago).
- **Notificaciones en el celular** (como una app): con la página instalada en la pantalla de inicio. Va junto con "Instalar Holo como app".
