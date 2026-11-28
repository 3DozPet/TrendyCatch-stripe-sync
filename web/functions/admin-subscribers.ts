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

// DELETE /admin-subscribers?email=<address> — removes one signup, e.g. a
// stray test record. Deletes both the per-subscriber KV key and its entry in
// the "subscribers:all" index, so it stops showing up on refresh.
export const onRequestDelete: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "ORDERS_KV not bound" }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return json({ error: "unauthorized" }, 401)

  const email = (new URL(request.url).searchParams.get("email") || "").trim().toLowerCase()
  if (!email) return json({ error: "email is required" }, 400)

  const key = `subscriber:${await sha256Hex(email)}`
  await env.ORDERS_KV.delete(key)

  const indexRaw = await env.ORDERS_KV.get("subscribers:all")
  if (indexRaw) {
    try {
      const parsed = JSON.parse(indexRaw)
      if (Array.isArray(parsed)) {
        const filtered = parsed.filter((s: any) => (s?.email || "").toLowerCase() !== email)
        await env.ORDERS_KV.put("subscribers:all", JSON.stringify(filtered))
      }
    } catch {
      // index was malformed anyway; nothing more to clean up
    }
  }

  return json({ ok: true })
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
