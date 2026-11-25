// POST /admin-backfill-stripe
//
// The webhook in stripe-order-sync.ts only records an order into D1 at the
// moment Stripe fires checkout.session.completed — so any order placed
// before that webhook was wired up (or any delivery it missed) never shows
// up in the Order History panel or under a customer's nested order list,
// even though Stripe itself still has it. This endpoint closes that gap:
// it pulls every PAID Checkout Session Stripe has on file and writes each
// one into the same orders/order_items tables the webhook uses.
//
// Safe to run more than once — recordOrderHistory uses INSERT OR IGNORE on
// Stripe's own session/line-item IDs, so re-running this never duplicates
// an order; it only ever fills in ones that are missing.
import { hasValidSession } from './_lib/auth'
import { recordOrderHistory, fetchAllPaidCheckoutSessions } from './_lib/stripe-orders'

interface Env {
  ORDERS_KV?: KVNamespace
  ORDERS_DB?: D1Database
  STRIPE_SECRET_KEY?: string
  STRIPE_SECONDARY_SECRET_KEY?: string
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)
  const accounts = [
    { label: 'Primary', key: env.STRIPE_SECRET_KEY?.trim() },
    { label: 'Secondary', key: env.STRIPE_SECONDARY_SECRET_KEY?.trim() },
  ].filter(account => account.key)
  if (!accounts.length) return reply({ error: 'Stripe is not configured' }, 503)

  let scanned = 0
  let written = 0
  let truncated = false
  const failures: string[] = []
  const processed = new Set<string>()
  for (const account of accounts) {
    try {
      const result = await fetchAllPaidCheckoutSessions(account.key!)
      scanned += result.sessions.length + result.fetchFailures.length
      truncated ||= result.truncated
      failures.push(...result.fetchFailures.map(error => `${account.label}: ${error}`))
      for (const session of result.sessions) {
        if (processed.has(session.id)) continue
        try {
          await recordOrderHistory(env.ORDERS_DB, session)
          processed.add(session.id)
          written++
        } catch {
          failures.push(`${account.label}: could not save ${session.id}`)
        }
      }
    } catch (error) {
      failures.push(`${account.label}: ${(error as Error).message || 'Stripe request failed'}`)
    }
  }

  return reply({
    ok: failures.length === 0,
    scanned,
    written,
    truncated,
    failures: failures.slice(0, 20),
  })
}
