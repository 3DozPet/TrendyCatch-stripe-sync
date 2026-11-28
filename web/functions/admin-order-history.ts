import { hasValidSession } from './_lib/auth'
import { sendOrderEmail } from './_lib/order-email'

interface Env { ORDERS_KV?: KVNamespace; ORDERS_DB?: D1Database; RESEND_API_KEY?: string }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  // order_number is a stable, human-friendly sequence (1, 2, 3…) derived
  // from insertion order — the TC-000001 shown in the dashboard — kept
  // separate from `id`, which stays the full Stripe checkout session ID
  // that every other query/webhook/email already keys off of.
  const result = await env.ORDERS_DB.prepare(
    `WITH numbered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS order_number FROM orders)
     SELECT o.id, o.created_at, o.customer_name, o.customer_email, o.customer_phone, o.shipping_name, o.shipping_address_json, o.billing_address_json, o.currency, o.total_minor, o.payment_status, o.fulfillment_status, o.tracking_number, o.tracking_carrier, o.tracking_url, o.updated_at, n.order_number
     FROM orders o JOIN numbered n ON n.id = o.id
     ORDER BY o.created_at DESC, o.id DESC LIMIT 100`
  ).all()
  const orders = result.results || []
  const items = await env.ORDERS_DB.prepare('SELECT order_id, product_id, title, variant, quantity, unit_amount_minor, image_url FROM order_items WHERE order_id IN (SELECT id FROM orders ORDER BY created_at DESC, id DESC LIMIT 100) ORDER BY id').all()
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
  const existing = await env.ORDERS_DB.prepare('SELECT id, fulfillment_status, tracking_number FROM orders WHERE id = ?').bind(input.id).first()
  if (!existing) return reply({ error: 'Order not found' }, 404)
  if (existing.fulfillment_status === 'cancelled') return reply({ error: 'Cancelled orders cannot be fulfilled' }, 409)
  // Did this save actually add/change a tracking number? Compare against what
  // was on the order before this update, so re-saving the same fulfilment
  // form (e.g. just editing the carrier name) doesn't re-send the shipped
  // email every time — only a genuinely new/changed tracking number does.
  const trackingChanged = Boolean(number) && number !== (existing.tracking_number ?? '')

  await env.ORDERS_DB.batch([
    env.ORDERS_DB.prepare('UPDATE orders SET fulfillment_status = ?, tracking_number = ?, tracking_carrier = ?, tracking_url = ?, updated_at = ? WHERE id = ?').bind(input.status, number || null, carrier || null, url || null, now, input.id),
    env.ORDERS_DB.prepare('INSERT INTO order_events (order_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)').bind(input.id, 'manual_fulfillment_update', now, JSON.stringify({ status: input.status, trackingNumber: number, carrier, url }))
  ])

  // Everything (tracking, customer notification) is handled right here on
  // this dashboard — no separate "send confirmation" click required.
  // Best-effort: a failed/unconfigured email never fails the fulfilment save
  // that already succeeded above.
  let email: { sent: boolean; error?: string } = { sent: false }
  if (input.status === 'fulfilled' && trackingChanged) {
    const result = await sendOrderEmail(env, input.id, 'shipped')
    email = result.ok ? { sent: true } : { sent: false, error: result.skipped ? undefined : result.error }
  }

  return reply({ ok: true, email })
}
