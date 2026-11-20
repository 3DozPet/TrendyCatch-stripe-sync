// GET /admin-subscribers — the only way to read the email signup list
// written by /subscribe. Gated exactly like /stats, /admin-orders and
// /live-visitors: customer info is for the store owner's eyes only, never
// public.
import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) {
    return json({ subscribers: [], count: 0, error: "ORDERS_KV not bound" })
  }

  if (!(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }

  const list = await env.ORDERS_KV.list({ prefix: "subscriber:", limit: 1000 })
  const subscribers: any[] = []

  for (const k of list.keys) {
    const raw = await env.ORDERS_KV.get(k.name)
    if (!raw) continue
    try {
      subscribers.push(JSON.parse(raw))
    } catch {
      // skip malformed entry
    }
  }

  subscribers.sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1))

  return json({ subscribers, count: subscribers.length })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
