// GET /admin-orders?since=<timestamp>
// Feeds the /admin.html order-alert dashboard. Reads the "orders:feed" KV
// key — a single rolling JSON array (newest 50, newest first) maintained by
// pushToOrderFeed() in _lib/stripe-sync-core.ts whenever a new order lands.
//
// This used to be env.ORDERS_KV.list({ prefix: "order:" }) with one KV key
// per order, but list() is capped at 1,000 calls/day on Workers KV's free
// plan account-wide, and this endpoint alone is polled every 5s — that blew
// through the daily cap within minutes of the dashboard being open, after
// which every list() call failed and the dashboard showed "Reconnecting…"
// all day. A single get() has no such cap, so this endpoint must never go
// back to list().

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

  const raw = await env.ORDERS_KV.get("orders:feed")
  let feed: any[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) feed = parsed
    } catch {
      feed = []
    }
  }

  const orders = feed.filter((o) => Number(o?.ts ?? 0) > since).slice(0, 20)

  return json({ orders, serverNow: Date.now() })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
