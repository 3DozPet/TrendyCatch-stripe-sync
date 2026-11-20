// POST /visitor-ping
// A tiny heartbeat the landing page (index.html) sends every ~20s while
// someone has it open, so the admin dashboard can show "who's live on the
// page right now" — the same kind of thing Shopify's Live View shows.
// Writes one short-lived KV entry per visitor session; entries expire on
// their own (~45s) if the heartbeat stops, so "live" always means "actually
// still here", never a stale count.
//
// Country comes from Cloudflare's own edge geolocation (request.cf.country),
// not anything the client claims, so it can't be spoofed by the page.

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

  const cf = (request as any).cf as { country?: string } | undefined
  const entry = {
    country: cf?.country ?? "UNKNOWN",
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
