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
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)
  if (!env.STRIPE_SECRET_KEY) return reply({ error: 'Stripe is not configured' }, 503)

  let sessions: any[]
  let truncated = false
  try {
    const result = await fetchAllPaidCheckoutSessions(env.STRIPE_SECRET_KEY)
    sessions = result.sessions
    truncated = result.truncated
  } catch (error) {
    return reply({ error: (error as Error).message || 'Stripe request failed' }, 502)
  }

  let written = 0
  const failures: string[] = []
  for (const session of sessions) {
    try {
      await recordOrderHistory(env.ORDERS_DB, session)
      written++
    } catch (error) {
      failures.push(`${session.id}: ${(error as Error).message}`)
    }
  }

  return reply({
    ok: failures.length === 0,
    scanned: sessions.length,
    written,
    truncated, // true if Stripe has more paid sessions than the safety cap fetched — re-run to continue
    failures: failures.slice(0, 20),
  })
}
