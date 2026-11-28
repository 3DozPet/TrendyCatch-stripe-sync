// POST /admin-order-status — the "rest of the lifecycle" past fulfilment:
// marking an order Delivered, and tracking a Return through Requested ->
// Received -> Refunded. Kept as its own endpoint (rather than folded into
// admin-order-history.ts's existing fulfilment POST) so the existing
// shipping/tracking save path is untouched — this only ever writes to the
// three additive columns from migration 0004 (delivered_at, return_status,
// return_updated_at), never fulfillment_status itself.
//
// Both fields are optional and independent: a request can set delivered,
// returnStatus, both, or neither (which would just be a no-op). Returns can
// happen on a delivered order or one still in transit, so this deliberately
// doesn't require or check fulfillment_status.

import { hasValidSession } from './_lib/auth'

interface Env { ORDERS_KV?: KVNamespace; ORDERS_DB?: D1Database }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

const RETURN_STATUSES = new Set(['requested', 'received', 'refunded'])

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)

  let input: any
  try { input = await request.json() } catch { return reply({ error: 'Invalid request' }, 400) }
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) return reply({ error: 'Invalid order' }, 400)

  const existing = await env.ORDERS_DB.prepare('SELECT id FROM orders WHERE id = ?').bind(input.id).first()
  if (!existing) return reply({ error: 'Order not found' }, 404)

  const now = new Date().toISOString()
  const sets: string[] = []
  const params: Array<string | null> = []
  const eventDetail: Record<string, unknown> = {}

  if ('delivered' in input) {
    if (typeof input.delivered !== 'boolean') return reply({ error: 'delivered must be true or false' }, 400)
    sets.push('delivered_at = ?')
    params.push(input.delivered ? now : null)
    eventDetail.delivered = input.delivered
  }

  if ('returnStatus' in input) {
    const value = input.returnStatus
    if (value !== null && !RETURN_STATUSES.has(value)) {
      return reply({ error: "returnStatus must be 'requested', 'received', 'refunded', or null" }, 400)
    }
    sets.push('return_status = ?', 'return_updated_at = ?')
    params.push(value, value ? now : null)
    eventDetail.returnStatus = value
  }

  if (!sets.length) return reply({ error: 'Nothing to update' }, 400)

  const sql = `UPDATE orders SET ${sets.join(', ')}, updated_at = ? WHERE id = ?`
  await env.ORDERS_DB.batch([
    env.ORDERS_DB.prepare(sql).bind(...params, now, input.id),
    env.ORDERS_DB.prepare('INSERT INTO order_events (order_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)').bind(input.id, 'order_status_update', now, JSON.stringify(eventDetail)),
  ])

  return reply({ ok: true })
}
