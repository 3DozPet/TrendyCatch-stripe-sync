// GET /admin-subscribers — the only way to read the email signup list
// written by /subscribe. Gated exactly like /stats, /admin-orders and
// /live-visitors: customer info is for the store owner's eyes only, never
// public.
//
// Reads the "subscribers:all" KV key (maintained by subscribe.ts on every
// signup) instead of list()-ing every subscriber: key. Workers KV's free
// plan caps list() at 1,000 calls/day account-wide, shared with every other
// endpoint — this used to be polled every 15s, which was most of the way to
// blowing that budget on its own. Must stay a single get(), never list().
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

  const raw = await env.ORDERS_KV.get("subscribers:all")
  let subscribers: any[] = []
  if (raw) {
    try {
      const parsed = JSON.parse(raw)
      if (Array.isArray(parsed)) subscribers = parsed
    } catch {
      subscribers = []
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
