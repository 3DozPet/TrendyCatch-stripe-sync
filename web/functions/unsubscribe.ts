// GET/POST /unsubscribe?email=... — the landing page behind the coupon
// email's List-Unsubscribe header (both the mailto: fallback and the
// one-click https link point here). Mail providers increasingly judge
// inbox placement partly on whether bulk/marketing mail offers a real,
// working one-click unsubscribe (RFC 8058) — this endpoint, plus the
// List-Unsubscribe headers added in subscribe.ts, is that.
//
// It only ever flags the *marketing* subscriber record. It never touches
// order/shipping data and never stops a transactional email (order
// confirmation, shipping notice) — those aren't marketing and customers
// can't opt out of hearing about their own order.

interface Env {
  ORDERS_KV?: KVNamespace
}

async function handle(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url)
  const email = (url.searchParams.get("email") || "").trim().toLowerCase()

  if (!env.ORDERS_KV || !email) {
    return html("That unsubscribe link looks incomplete. Email orders@trendycatch.us and we'll take care of it.", 400)
  }

  const key = `subscriber:${await sha256Hex(email)}`
  const raw = await env.ORDERS_KV.get(key)
  if (raw) {
    try {
      const record = JSON.parse(raw)
      record.unsubscribed = true
      record.unsubscribedAt = new Date().toISOString()
      await env.ORDERS_KV.put(key, JSON.stringify(record))
    } catch {
      // Malformed record — nothing to flag, but don't error the request.
    }
  }

  // One-click POST (List-Unsubscribe-Post) gets a bare 200; a browser GET
  // (someone clicking the link directly) gets a short human-readable page.
  if (request.method === "POST") return new Response(null, { status: 200 })
  return html(`You're unsubscribed. ${email} won't get any more marketing emails from TrendyCatch.`, 200)
}

export const onRequestGet: PagesFunction<Env> = ({ request, env }) => handle(request, env)
export const onRequestPost: PagesFunction<Env> = ({ request, env }) => handle(request, env)

function html(message: string, status: number): Response {
  const body = `<!doctype html><html><head><meta charset="utf-8"><title>Unsubscribed — TrendyCatch</title>
  <meta name="viewport" content="width=device-width,initial-scale=1"></head>
  <body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:80px auto;padding:0 20px;color:#2b2230;text-align:center;">
  <p style="font-size:16px;line-height:1.6;">${escapeHtml(message)}</p>
  </body></html>`
  return new Response(body, { status, headers: { "content-type": "text/html; charset=utf-8" } })
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}
