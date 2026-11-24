// POST /admin-backfill-stripe
//
// The webhook in stripe-order-sync.ts / stripe-order-sync-2.ts only records
// an order into D1 at the moment Stripe fires checkout.session.completed —
// so any order placed before that webhook was wired up (or any delivery it
// missed, e.g. account 2 before its endpoint existed) never shows up in the
// Order History panel or under a customer's nested order list, even though
// Stripe itself still has it. This endpoint closes that gap: for every
// Stripe account with a secret key configured, it pulls every PAID Checkout
// Session that account has on file and writes each one into the same
// orders/order_items tables the webhooks use. The orders table has no
// per-account column (see 0001_orders.sql) — Stripe session IDs are unique
// per account, so sessions from both accounts coexist safely by the same
// INSERT OR IGNORE key.
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
  STRIPE_SECRET_KEY_2?: string
}

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)

  const accounts: { label: string; key: string }[] = []
  if (env.STRIPE_SECRET_KEY) accounts.push({ label: 'account 1', key: env.STRIPE_SECRET_KEY })
  if (env.STRIPE_SECRET_KEY_2) accounts.push({ label: 'account 2', key: env.STRIPE_SECRET_KEY_2 })
  if (accounts.length === 0) return reply({ error: 'Stripe is not configured' }, 503)

  let scanned = 0
  let written = 0
  let truncated = false
  const failures: string[] = []

  for (const account of accounts) {
    let sessions: any[]
    try {
      const result = await fetchAllPaidCheckoutSessions(account.key)
      sessions = result.sessions
      truncated = truncated || result.truncated
      failures.push(...result.fetchFailures.map((f) => `[${account.label}] ${f}`))
      scanned += sessions.length + result.fetchFailures.length
    } catch (error) {
      failures.push(`[${account.label}] ${(error as Error).message || 'Stripe request failed'}`)
      continue
    }

    for (const session of sessions) {
      try {
        await recordOrderHistory(env.ORDERS_DB, session)
        written++
      } catch (error) {
        failures.push(`[${account.label}] ${session.id}: ${(error as Error).message}`)
      }
    }
  }

  return reply({
    ok: failures.length === 0,
    accountsScanned: accounts.map((a) => a.label),
    scanned, // total paid sessions Stripe reported, across every configured account
    written,
    truncated, // true if an account has more paid sessions than the safety cap fetched — re-run to continue
    failures: failures.slice(0, 20),
  })
}
