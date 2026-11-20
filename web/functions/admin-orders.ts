// GET /admin-orders?since=<timestamp>
// Feeds the /admin.html order-alert dashboard. Lists recent "new order"
// notifications written by stripe-order-sync.ts into KV, newest first.
// Polled every few seconds by admin.html, which plays a chime for anything
// newer than the last order it already showed.

import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) {
    return json({ orders: [], error: "ORDERS_KV not bound" }, 200)
  }

  if (!(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }

  const url = new URL(request.url)
  const since = Number(url.searchParams.get("since") ?? "0")

  const list = await env.ORDERS_KV.list({ prefix: "order:", limit: 50 })
  const keys = list.keys.map((k) => k.name).sort().reverse() // newest first (timestamp is in the key)

  const orders: any[] = []
  for (const key of keys) {
    // key format: order:<timestampMs>:<sessionHash>
    const ts = Number(key.split(":")[1] ?? "0")
    if (ts <= since) continue
    const raw = await env.ORDERS_KV.get(key)
    if (raw) {
      try {
        orders.push({ ...JSON.parse(raw), ts })
      } catch {
        // skip malformed entry
      }
    }
    if (orders.length >= 20) break
  }

  return json({ orders, serverNow: Date.now() })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
