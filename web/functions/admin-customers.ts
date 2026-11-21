// GET /admin-customers
// Aggregates customers directly from Stripe's own completed Checkout
// Sessions (grouped by email), rather than depending on the D1
// ORDERS_DB — which isn't provisioned yet. STRIPE_SECRET_KEY is already
// bound for stripe-order-sync.ts, so this works immediately with real
// data and needs no new infrastructure.
//
// Once ORDERS_DB is provisioned, this can be pointed at it instead (or
// used as a fallback) for faster, paginated queries — Stripe's API is
// fine for "last ~100-200 orders" aggregation but isn't a substitute
// for durable local storage long-term.

import { hasValidSession } from './_lib/auth'

interface Env {
  ORDERS_KV?: KVNamespace
  STRIPE_SECRET_KEY?: string
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return reply({ error: 'Unauthorized' }, 401)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  if (!env.STRIPE_SECRET_KEY) return reply({ error: 'Stripe is not configured' }, 503)

  let sessions: any[]
  try {
    sessions = await fetchCompletedSessions(env.STRIPE_SECRET_KEY, 200)
  } catch (error) {
    return reply({ error: (error as Error).message || 'Stripe request failed' }, 502)
  }

  const byEmail = new Map<string, {
    email: string; name: string | null; phone: string | null
    orderCount: number; totalSpentMinor: number; currency: string
    firstOrderAt: string; lastOrderAt: string
  }>()

  for (const session of sessions) {
    const details = session.customer_details
    const email: string | undefined = details?.email
    if (!email) continue
    const amount: number = session.amount_total ?? 0
    const currency: string = (session.currency || 'usd').toUpperCase()
    const createdAt = new Date(session.created * 1000).toISOString()
    const existing = byEmail.get(email)
    if (existing) {
      existing.orderCount += 1
      existing.totalSpentMinor += amount
      if (createdAt > existing.lastOrderAt) existing.lastOrderAt = createdAt
      if (createdAt < existing.firstOrderAt) existing.firstOrderAt = createdAt
      if (!existing.name && details?.name) existing.name = details.name
      if (!existing.phone && details?.phone) existing.phone = details.phone
    } else {
      byEmail.set(email, {
        email,
        name: details?.name ?? null,
        phone: details?.phone ?? null,
        orderCount: 1,
        totalSpentMinor: amount,
        currency,
        firstOrderAt: createdAt,
        lastOrderAt: createdAt,
      })
    }
  }

  const customers = [...byEmail.values()].sort((a, b) => (a.lastOrderAt < b.lastOrderAt ? 1 : -1))
  return reply({ customers, limit: 200, source: 'stripe' })
}

async function fetchCompletedSessions(secretKey: string, limit: number): Promise<any[]> {
  const out: any[] = []
  let startingAfter: string | undefined
  while (out.length < limit) {
    const params = new URLSearchParams({
      limit: String(Math.min(100, limit - out.length)),
      status: 'complete',
    })
    if (startingAfter) params.set('starting_after', startingAfter)
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    })
    if (!res.ok) throw new Error(`Stripe error ${res.status}: ${await res.text()}`)
    const json: any = await res.json()
    const data: any[] = json.data || []
    const paid = data.filter((s) => s.payment_status === 'paid')
    out.push(...paid)
    if (!json.has_more || data.length === 0) break
    startingAfter = data[data.length - 1].id
  }
  return out
}
