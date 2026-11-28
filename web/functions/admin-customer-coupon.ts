// GET /admin-customer-coupon?email=<address> — looks up one customer's
// welcome-coupon history (subscribed? code sent? used yet?) for the order
// detail modal. Deliberately a single on-demand lookup (two KV get()s, both
// well under Workers KV's free-tier budget) rather than folding this into
// the polled /admin-subscribers list — that endpoint is read every 15s by
// every open dashboard tab, and adding a per-subscriber coupon lookup there
// would multiply its KV reads by the subscriber count on every poll.

interface Env {
  ORDERS_KV?: KVNamespace
}

import { hasValidSession } from "./_lib/auth"

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "ORDERS_KV not bound" }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return json({ error: "unauthorized" }, 401)

  const email = (new URL(request.url).searchParams.get("email") || "").trim().toLowerCase()
  if (!email) return json({ error: "email is required" }, 400)

  const subscriberRaw = await env.ORDERS_KV.get(`subscriber:${await sha256Hex(email)}`)
  if (!subscriberRaw) return json({ subscribed: false })

  let subscriber: Record<string, unknown> = {}
  try {
    subscriber = JSON.parse(subscriberRaw)
  } catch {
    return json({ subscribed: false })
  }

  const couponCode = typeof subscriber.couponCode === "string" ? subscriber.couponCode : null
  let couponStatus: string | null = null
  let couponUsedAt: string | null = null
  if (couponCode) {
    const couponRaw = await env.ORDERS_KV.get(`coupon:${couponCode}`)
    if (couponRaw) {
      try {
        const coupon = JSON.parse(couponRaw)
        couponStatus = coupon.status || "unused"
        couponUsedAt = coupon.usedAt || null
      } catch {
        couponStatus = null
      }
    }
  }

  return json({
    subscribed: true,
    couponCode,
    couponEmailedAt: subscriber.couponEmailedAt || null,
    unsubscribed: Boolean(subscriber.unsubscribed),
    couponStatus,
    couponUsedAt,
  })
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
