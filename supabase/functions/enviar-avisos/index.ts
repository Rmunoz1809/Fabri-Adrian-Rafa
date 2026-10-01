// Supabase Edge Function: e-mails the notifications (migration 0021) through Resend.
// Called every few minutes by pg_cron (docs/08-avisos.md). Each run takes the pending notifications
// from the last 24 hours, groups them per person (one e-mail per person per run) and marks them sent,
// skipped (e-mail turned off in Mi cuenta, or older than a day) or failed (retried up to 3 times).
//
// Secrets (Supabase ▸ Edge Functions ▸ Secrets, never in the page or the repo):
//   RESEND_API_KEY   API key from resend.com (the sending domain must be verified there)
//   EMAIL_FROM       e.g. "Holo <avisos@tudominio.com>"
//   SITE_URL         e.g. https://rmunoz1809.github.io/Fabri-Adrian-Rafa/holo.html
//   CRON_SECRET      any long random text; pg_cron sends it in the x-cron-secret header
// Deploy:
//   supabase functions deploy enviar-avisos --no-verify-jwt --use-api --project-ref vqcpqoedsyatxswdzqcy
import { createClient } from "npm:@supabase/supabase-js@2";

type Row = { id: number; user_id: string; title: string; body: string | null; link: string | null; created_at: string; email_attempts: number };

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const escapeHtml = (s: string) =>
  s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
function sameText(a: string, b: string) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function renderEmail(rows: Row[], site: string) {
  const link = (l: string | null) => `${site}${l && /^#\/[\w\-/?=&.%]*$/.test(l) ? l : "#/avisos"}`;
  const subject = rows.length === 1 ? rows[0].title : `Tienes ${rows.length} avisos nuevos en Holo`;
  const items = rows.map((r) => `
    <tr><td style="padding:14px 0;border-bottom:1px solid #e6e7ec">
      <a href="${escapeHtml(link(r.link))}" style="color:#0b0d14;font-weight:700;text-decoration:none;font-size:15px">${escapeHtml(r.title)}</a>
      ${r.body ? `<div style="color:#4a4f5e;font-size:14px;margin-top:4px">${escapeHtml(r.body)}</div>` : ""}
    </td></tr>`).join("");
  const html = `<!doctype html><html lang="es"><body style="margin:0;background:#f4f5f8;font-family:Arial,Helvetica,sans-serif">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:24px 12px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#fff;border-radius:14px;padding:24px">
    <tr><td style="font-size:20px;font-weight:800;color:#0b0d14;padding-bottom:8px">Holo</td></tr>
    ${items}
    <tr><td style="padding-top:20px"><a href="${escapeHtml(`${site}#/avisos`)}" style="display:inline-block;background:#0b0d14;color:#fff;text-decoration:none;font-weight:700;padding:12px 18px;border-radius:999px;font-size:14px">Ver en Holo</a></td></tr>
    <tr><td style="padding-top:20px;color:#8a8f9e;font-size:12px">Recibes este correo porque tienes una cuenta en Holo. Puedes dejar de recibir avisos por correo en <a href="${escapeHtml(`${site}#/cuenta`)}" style="color:#8a8f9e">Mi cuenta</a>.</td></tr>
  </table></td></tr></table></body></html>`;
  const text = rows.map((r) => `${r.title}${r.body ? `\n${r.body}` : ""}\n${link(r.link)}`).join("\n\n") +
    `\n\nPuedes dejar de recibir avisos por correo en Mi cuenta: ${site}#/cuenta`;
  return { subject: subject.slice(0, 150), html, text };
}

Deno.serve(async (req) => {
  const secret = Deno.env.get("CRON_SECRET") ?? "";
  if (!secret || !sameText(req.headers.get("x-cron-secret") ?? "", secret)) return json({ error: "unauthorized" }, 401);
  const apiKey = Deno.env.get("RESEND_API_KEY"), from = Deno.env.get("EMAIL_FROM"), site = Deno.env.get("SITE_URL");
  if (!apiKey || !from || !site) return json({ error: "E-mail not configured" }, 503);

  const db = createClient(Deno.env.get("SUPABASE_URL")!, Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!, { auth: { persistSession: false } });
  const dayAgo = new Date(Date.now() - 24 * 3600 * 1000).toISOString();
  // Anything older than a day is no longer news (e.g. while e-mail was not set up yet).
  await db.from("notifications").update({ email_status: "skipped" }).eq("email_status", "pending").lt("created_at", dayAgo);

  const { data, error } = await db.from("notifications")
    .select("id, user_id, title, body, link, created_at, email_attempts")
    .eq("email_status", "pending").gte("created_at", dayAgo).lt("email_attempts", 3)
    .order("created_at", { ascending: true }).limit(200);
  if (error) { console.error("enviar-avisos: read", error); return json({ error: "read failed" }, 500); }
  const byUser = new Map<string, Row[]>();
  for (const r of (data ?? []) as Row[]) byUser.set(r.user_id, [...(byUser.get(r.user_id) ?? []), r]);
  if (!byUser.size) return json({ sent: 0 });

  const { data: prefs } = await db.from("notification_settings").select("user_id, email").in("user_id", [...byUser.keys()]);
  const off = new Set((prefs ?? []).filter((p) => p.email === false).map((p) => p.user_id));
  let sent = 0, failed = 0, skipped = 0;

  for (const [userId, rows] of byUser) {
    const ids = rows.map((r) => r.id);
    if (off.has(userId)) { await db.from("notifications").update({ email_status: "skipped" }).in("id", ids); skipped += ids.length; continue; }
    const { data: u } = await db.auth.admin.getUserById(userId);
    const to = u?.user?.email;
    if (!to) { await db.from("notifications").update({ email_status: "skipped" }).in("id", ids); skipped += ids.length; continue; }
    const mail = renderEmail(rows.slice(0, 10), site);
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from, to: [to], subject: mail.subject, html: mail.html, text: mail.text }),
      signal: AbortSignal.timeout(15000),
    }).catch((e) => { console.error("enviar-avisos: resend", e); return null; });
    if (res?.ok) {
      await db.from("notifications").update({ email_status: "sent" }).in("id", ids);
      sent += ids.length;
    } else {
      console.error("enviar-avisos: resend status", res?.status, await res?.text().catch(() => ""));
      for (const r of rows) {
        await db.from("notifications").update({ email_attempts: r.email_attempts + 1, email_status: r.email_attempts + 1 >= 3 ? "failed" : "pending" }).eq("id", r.id);
      }
      failed += ids.length;
    }
  }
  return json({ sent, failed, skipped });
});
