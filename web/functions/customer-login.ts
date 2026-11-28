// POST /customer-login — step 1 of the customer "my orders" magic-link
// flow. Customer submits their email; if it matches any order on file, a
// one-time sign-in link is emailed via Resend.
//
// Always responds with the same generic message regardless of whether the
// email matches an order, and the response time is evened out to a fixed
// floor — so this endpoint can't be used to find out which email addresses
// have ordered from the store (no account-enumeration side channel).

import { allowLoginRequest, createLoginToken } from "./_lib/customer-auth"

interface Env {
  ORDERS_KV?: KVNamespace
  ORDERS_DB?: D1Database
  RESEND_API_KEY?: string
}

const GENERIC_MESSAGE = "If that email has orders with us, we've just sent a sign-in link. It expires in 15 minutes."
const MIN_RESPONSE_MS = 400

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const started = Date.now()
  const respond = async (body: Record<string, unknown>, status = 200) => {
    const elapsed = Date.now() - started
    if (elapsed < MIN_RESPONSE_MS) await new Promise((r) => setTimeout(r, MIN_RESPONSE_MS - elapsed))
    return json(body, status)
  }

  if (!env.ORDERS_KV || !env.ORDERS_DB) return respond({ error: "Server not configured." }, 500)

  let body: { email?: string } = {}
  try {
    body = await request.json()
  } catch {
    // validated below
  }
  const email = (body.email || "").trim().toLowerCase()
  if (!isLikelyEmail(email)) return respond({ error: "Please enter a valid email address." }, 400)

  const ip = request.headers.get("cf-connecting-ip") || "unknown"
  const allowed = await allowLoginRequest(env.ORDERS_KV, email, ip)
  if (!allowed) return respond({ ok: true, message: GENERIC_MESSAGE })

  const match = await env.ORDERS_DB
    .prepare("SELECT 1 FROM orders WHERE LOWER(customer_email) = ? LIMIT 1")
    .bind(email)
    .first()

  if (match && env.RESEND_API_KEY) {
    const token = await createLoginToken(env.ORDERS_KV, email)
    await sendLoginEmail(env.RESEND_API_KEY, email, token).catch(() => {})
  }

  return respond({ ok: true, message: GENERIC_MESSAGE })
}

async function sendLoginEmail(apiKey: string, to: string, token: string): Promise<void> {
  const link = `https://trendycatch.us/my-orders.html?token=${encodeURIComponent(token)}`
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:480px;margin:0 auto;color:#2b2230;">
    <h2 style="font-size:20px;margin:0 0 12px;">Sign in to TrendyCatch</h2>
    <p style="font-size:15px;line-height:1.6;">Click below to see your orders. This link works once and expires in 15 minutes.</p>
    <p style="margin:20px 0;"><a href="${link}" style="background:#5a3ec8;color:#fff;padding:12px 22px;border-radius:10px;text-decoration:none;font-weight:700;display:inline-block;">View my orders</a></p>
    <p style="font-size:12px;line-height:1.6;color:#9b93a8;">If you didn't request this, you can safely ignore this email — no one can access your orders without clicking this exact link.</p>
  </div>`
  await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
    body: JSON.stringify({ from: "TrendyCatch <orders@trendycatch.us>", to: [to], subject: "Sign in to TrendyCatch", html }),
  })
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/.test(value) && value.length <= 254
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
