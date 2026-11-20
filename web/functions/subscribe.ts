// POST /subscribe — the storefront's "get 10% off" email capture. Public and
// anonymous (anyone browsing can sign up), but what it stores is NOT public:
// the signup list is only ever read back through /admin-subscribers, which is
// gated the same way as the rest of the dashboard (hasValidSession).
// Dedupes by email so submitting twice just refreshes the record instead of
// creating duplicates.

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)

  let body: { email?: string; source?: string; landingUrl?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore, validated below
  }

  const email = (body.email || "").trim().toLowerCase()
  if (!isLikelyEmail(email)) {
    return json({ error: "Please enter a valid email address." }, 400)
  }

  const country = (request as any).cf?.country ?? "UNKNOWN"
  const key = `subscriber:${await sha256Hex(email)}`

  const existingRaw = await env.ORDERS_KV.get(key)
  const createdAt = existingRaw ? JSON.parse(existingRaw).createdAt : new Date().toISOString()

  const record = {
    email,
    country,
    source: (body.source || "direct").toString().slice(0, 100),
    landingUrl: (body.landingUrl || "").toString().slice(0, 500),
    createdAt,
    updatedAt: new Date().toISOString(),
  }

  // Signups never expire — this is a durable list, not a rolling feed.
  await env.ORDERS_KV.put(key, JSON.stringify(record))

  return json({ ok: true })
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/.test(value) && value.length <= 254
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}
