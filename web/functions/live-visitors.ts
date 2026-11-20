// GET /live-visitors
// Polled by /admin.html to show a Shopify-Live-View-style "N live on the
// page right now" count, broken down by country. Counts the still-valid
// (not yet expired) visitor:* heartbeat entries written by visitor-ping.ts.

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  if (!env.ORDERS_KV) {
    return json({ count: 0, byCountry: {}, error: "ORDERS_KV not bound" })
  }

  const list = await env.ORDERS_KV.list({ prefix: "visitor:", limit: 500 })
  const byCountry: Record<string, number> = {}
  let count = 0

  for (const k of list.keys) {
    const raw = await env.ORDERS_KV.get(k.name)
    if (!raw) continue // already expired between list() and get()
    try {
      const entry = JSON.parse(raw)
      const country = entry.country ?? "UNKNOWN"
      byCountry[country] = (byCountry[country] ?? 0) + 1
      count += 1
    } catch {
      // skip malformed entry
    }
  }

  return json({ count, byCountry })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
