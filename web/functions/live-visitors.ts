// GET /live-visitors
// Polled by /admin.html to show a Shopify-Live-View-style "N live on the
// page right now" count, broken down by country, plus a per-visitor list
// (id/lat/lon/country/city) that the Home tab's live world map plots as
// pins. Counts the still-valid (not yet expired) visitor:* heartbeat
// entries written by visitor-ping.ts.
//
// Unlike admin-orders/admin-subscribers, this one genuinely needs list() —
// visitor heartbeats come from many independent page loads, with no single
// writer that could maintain a rolling count instead. But Workers KV's free
// plan caps list() at 1,000 calls/day account-wide, and this endpoint is
// polled every 5s by admin.html, which alone would exceed that in well
// under an hour (it's what was causing every list()-based endpoint,
// including the order feed, to start 500ing with "KV list() limit exceeded
// for the day"). So the real list()+get() scan only runs once every
// CACHE_TTL_MS; every poll in between is served the cached snapshot via a
// single get() on "visitors:snapshot". Worst case, even left open 24/7, this
// is 86400s / 45s ≈ 1,920 recomputes/day — comfortably under budget once
// admin-orders and admin-subscribers (together far bigger consumers) no
// longer call list() at all.

import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

const SNAPSHOT_KEY = "visitors:snapshot"
const CACHE_TTL_MS = 45_000

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) {
    return json({ count: 0, byCountry: {}, error: "ORDERS_KV not bound" })
  }

  if (!(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }

  const cachedRaw = await env.ORDERS_KV.get(SNAPSHOT_KEY)
  if (cachedRaw) {
    try {
      const cached = JSON.parse(cachedRaw)
      if (Date.now() - Number(cached.computedAt ?? 0) < CACHE_TTL_MS) {
        return json({ count: cached.count, byCountry: cached.byCountry, visitors: cached.visitors ?? [] })
      }
    } catch {
      // fall through and recompute
    }
  }

  const list = await env.ORDERS_KV.list({ prefix: "visitor:", limit: 500 })
  const byCountry: Record<string, number> = {}
  const visitors: Array<{ id: string; country: string; city?: string; lat?: number; lon?: number; ts: number }> = []
  let count = 0

  for (const k of list.keys) {
    const raw = await env.ORDERS_KV.get(k.name)
    if (!raw) continue // already expired between list() and get()
    try {
      const entry = JSON.parse(raw)
      const country = entry.country ?? "UNKNOWN"
      byCountry[country] = (byCountry[country] ?? 0) + 1
      count += 1
      // The map only needs a stable per-heartbeat id and a point to plot —
      // drop entries Cloudflare couldn't geolocate rather than guessing.
      if (typeof entry.lat === "number" && typeof entry.lon === "number") {
        visitors.push({
          id: k.name.slice("visitor:".length),
          country,
          city: entry.city,
          lat: entry.lat,
          lon: entry.lon,
          ts: entry.ts ?? Date.now(),
        })
      }
    } catch {
      // skip malformed entry
    }
  }

  try {
    await env.ORDERS_KV.put(SNAPSHOT_KEY, JSON.stringify({ count, byCountry, visitors, computedAt: Date.now() }), {
      expirationTtl: 120,
    })
  } catch (err) {
    console.error("visitors:snapshot cache write failed (count still returned this request):", (err as Error).message)
  }

  return json({ count, byCountry, visitors })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
