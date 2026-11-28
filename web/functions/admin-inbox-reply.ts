// POST /admin-inbox-reply — send a plain-text reply (or a brand-new message)
// from the dashboard's inbox window. Same gate as every other admin write:
// valid session + same-origin request. Defaults to orders@trendycatch.us;
// pass `from: "robbie@trendycatch.us"` to reply as Robbie's own address
// instead (e.g. when replying to a thread that came in on robbie@) — that
// address additionally requires the X-Admin-Key header (ADMIN_INBOX_KEY, a
// Cloudflare secret), the same second password that gates reading robbie@'s
// mail in /admin-inbox.
import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
  RESEND_API_KEY?: string
  ADMIN_INBOX_KEY?: string
}

const ALLOWED_FROM = new Set(["orders@trendycatch.us", "robbie@trendycatch.us"])

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !(await hasValidSession(request, env.ORDERS_KV))) return json({ error: "Unauthorized" }, 401)
  const origin = request.headers.get("Origin")
  if (!origin || origin !== new URL(request.url).origin) return json({ error: "Invalid request origin" }, 403)
  if (!env.RESEND_API_KEY) return json({ error: "Email sending isn't set up yet." }, 503)

  let input: any
  try { input = await request.json() } catch { return json({ error: "Invalid request" }, 400) }
  const to = typeof input.to === "string" ? input.to.trim() : ""
  const subject = typeof input.subject === "string" ? input.subject.trim().slice(0, 200) : ""
  const text = typeof input.text === "string" ? input.text.trim().slice(0, 10000) : ""
  const messageId = typeof input.messageId === "string" ? input.messageId.trim().slice(0, 300) : ""
  const fromAddress = typeof input.from === "string" && ALLOWED_FROM.has(input.from.trim().toLowerCase())
    ? input.from.trim().toLowerCase()
    : "orders@trendycatch.us"
  if (fromAddress === "robbie@trendycatch.us") {
    if (!env.ADMIN_INBOX_KEY) return json({ error: "Admin inbox isn't set up yet (ADMIN_INBOX_KEY missing)." }, 503)
    const given = request.headers.get("X-Admin-Key") || ""
    if (given !== env.ADMIN_INBOX_KEY) return json({ error: "wrong_password" }, 403)
  }
  if (!/^[^\s@<>"'&,;]+@[^\s@<>"'&,;]+\.[^\s@<>"'&,;]+$/.test(to) || to.length > 254) return json({ error: "That email address doesn't look right." }, 400)
  if (!text) return json({ error: "Write a reply first." }, 400)

  const body: Record<string, unknown> = {
    from: `TrendyCatch <${fromAddress}>`,
    to: [to],
    subject: subject || "Re: your message to TrendyCatch",
    text,
  }
  if (/^<[^<>\s]+>$/.test(messageId)) body.headers = { "In-Reply-To": messageId, References: messageId }

  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    if (!res.ok) return json({ error: `Email provider declined to send (status ${res.status}).` }, 502)
  } catch {
    return json({ error: "Could not reach the email provider. Try again shortly." }, 502)
  }
  return json({ ok: true })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
