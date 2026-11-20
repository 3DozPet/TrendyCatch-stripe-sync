// GET /stats
// Feeds the "home screen" summary on /admin.html: total revenue, total
// orders, revenue broken down by country and by ad platform — the running
// totals stripe-order-sync.ts keeps in KV under the "stats:summary" key.
// Separate endpoint from /admin-orders (the rolling 48h new-order feed) so
// the two can be polled at different rates and shown as different sections.

import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) {
    return json({ totalRevenue: 0, totalOrders: 0, byCountry: {}, bySource: {}, error: "ORDERS_KV not bound" })
  }

  if (!(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }

  const raw = await env.ORDERS_KV.get("stats:summary")
  if (!raw) {
    return json({ totalRevenue: 0, totalOrders: 0, byCountry: {}, bySource: {} })
  }

  try {
    return json(JSON.parse(raw))
  } catch {
    return json({ totalRevenue: 0, totalOrders: 0, byCountry: {}, bySource: {}, error: "corrupt stats, ignored" })
  }
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
