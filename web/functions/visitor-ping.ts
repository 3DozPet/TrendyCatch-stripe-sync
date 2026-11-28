// POST /visitor-ping
// A tiny heartbeat the landing page (index.html) sends every ~20s while
// someone has it open, so the admin dashboard can show "who's live on the
// page right now" — the same kind of thing Shopify's Live View shows.
// Writes one short-lived KV entry per visitor session; entries expire on
// their own (~45s) if the heartbeat stops, so "live" always means "actually
// still here", never a stale count.
//
// Country, city and approximate lat/lon come from Cloudflare's own edge
// geolocation (request.cf), not anything the client claims, so none of it
// can be spoofed by the page. The admin dashboard's live world map plots
// these points directly — no separate geo lookup needed.

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return new Response("ok", { status: 200 })

  let body: { visitorId?: string; page?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore malformed body, still record a heartbeat below with no page info
  }

  const visitorId = (body.visitorId || "").slice(0, 100)
  if (!visitorId) return new Response("missing visitorId", { status: 400 })

  const cf = (request as any).cf as { country?: string; city?: string; latitude?: string; longitude?: string } | undefined
  const lat = cf?.latitude ? Number(cf.latitude) : NaN
  const lon = cf?.longitude ? Number(cf.longitude) : NaN
  const entry = {
    country: cf?.country ?? "UNKNOWN",
    city: cf?.city ?? "",
    lat: Number.isFinite(lat) ? lat : null,
    lon: Number.isFinite(lon) ? lon : null,
    page: (body.page || "/").slice(0, 200),
    ts: Date.now(),
  }

  try {
    // 60s is Cloudflare KV's minimum TTL. The client pings every ~20s, so a
    // visitor stays "live" for a couple of missed beats before dropping off.
    await env.ORDERS_KV.put(`visitor:${visitorId}`, JSON.stringify(entry), { expirationTtl: 60 })
  } catch (err) {
    console.error("visitor-ping KV write failed:", (err as Error).message)
  }

  return new Response("ok", { status: 200 })
}
