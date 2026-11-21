import { hasValidSession } from './_lib/auth'

interface Env { ORDERS_KV?: KVNamespace; ORDERS_DB?: D1Database }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const result = await env.ORDERS_DB.prepare('SELECT id, created_at, customer_name, customer_email, customer_phone, shipping_name, shipping_address_json, billing_address_json, currency, total_minor, payment_status, fulfillment_status, tracking_number, tracking_carrier, tracking_url, updated_at FROM orders ORDER BY created_at DESC, id DESC LIMIT 100').all()
  const orders = result.results || []
  const items = await env.ORDERS_DB.prepare('SELECT order_id, product_id, title, variant, quantity, unit_amount_minor FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY created_at DESC, id DESC LIMIT 100) ORDER BY id').all()
  return reply({ orders, items: items.results || [], limit: 100 })
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)
  let input: any
  try { input = await request.json() } catch { return reply({ error: 'Invalid request' }, 400) }
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) return reply({ error: 'Invalid order' }, 400)
  if (input.status !== 'fulfilled' && input.status !== 'unfulfilled') return reply({ error: 'Invalid status' }, 400)
  const clean = (v: unknown, max: number) => typeof v === 'string' ? v.trim().slice(0, max) : ''
  const number = clean(input.trackingNumber, 100), carrier = clean(input.carrier, 100), url = clean(input.trackingUrl, 500)
  if (url) { try { if (new URL(url).protocol !== 'https:') throw Error() } catch { return reply({ error: 'Tracking link must use HTTPS' }, 400) } }
  const now = new Date().toISOString()
  const existing = await env.ORDERS_DB.prepare('SELECT id, fulfillment_status FROM orders WHERE id = ?').bind(input.id).first()
  if (!existing) return reply({ error: 'Order not found' }, 404)
  if (existing.fulfillment_status === 'cancelled') return reply({ error: 'Cancelled orders cannot be fulfilled' }, 409)
  await env.ORDERS_DB.batch([
    env.ORDERS_DB.prepare('UPDATE orders SET fulfillment_status = ?, tracking_number = ?, tracking_carrier = ?, tracking_url = ?, updated_at = ? WHERE id = ?').bind(input.status, number || null, carrier || null, url || null, now, input.id),
    env.ORDERS_DB.prepare('INSERT INTO order_events (order_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)').bind(input.id, 'manual_fulfillment_update', now, JSON.stringify({ status: input.status, trackingNumber: number, carrier, url }))
  ])
  return reply({ ok: true })
}
