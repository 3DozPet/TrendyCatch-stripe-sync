import { hasValidSession } from './_lib/auth'

interface Env { ORDERS_KV?: KVNamespace; ORDERS_DB?: D1Database; RESEND_API_KEY?: string }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
}

// Builds a plain, readable confirmation email from the order record stored in D1.
function buildEmailHtml(order: Record<string, unknown>, items: Array<Record<string, unknown>>): string {
  const currency = String(order.currency || 'USD').toUpperCase()
  const total = (Number(order.total_minor || 0) / 100).toFixed(2)
  const itemRows = items.length
    ? items.map((i) => `<li>${escapeHtml(String(i.quantity ?? 1))} × ${escapeHtml(String(i.title || 'Item'))}${i.variant ? ' — ' + escapeHtml(String(i.variant)) : ''}</li>`).join('')
    : '<li>Order details unavailable</li>'

  let addressHtml = ''
  try {
    if (order.shipping_address_json) {
      const a = JSON.parse(String(order.shipping_address_json))
      const lines = [order.shipping_name, a.line1, a.line2, [a.city, a.state, a.postal_code].filter(Boolean).join(', '), a.country].filter(Boolean)
      addressHtml = lines.map((l) => escapeHtml(String(l))).join('<br>')
    }
  } catch {
    // Malformed/legacy address JSON — leave the address block out rather than fail the send.
  }

  let trackingHtml = ''
  if (order.fulfillment_status === 'fulfilled' && order.tracking_number) {
    const link = (order.tracking_url as string) || `https://t.17track.net/en#nums=${encodeURIComponent(String(order.tracking_number))}`
    trackingHtml = `<p>Tracking: <a href="${escapeHtml(link)}">${escapeHtml(String(order.tracking_number))}</a>${order.tracking_carrier ? ' via ' + escapeHtml(String(order.tracking_carrier)) : ''}</p>`
  }

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#222;">
    <h2 style="margin-bottom:4px;">Thanks for your order${order.customer_name ? ', ' + escapeHtml(String(order.customer_name)) : ''}!</h2>
    <p style="color:#666;margin-top:0;">Order ${escapeHtml(String(order.id))}${order.created_at ? ' · ' + escapeHtml(String(order.created_at)) : ''}</p>
    <ul style="padding-left:18px;">${itemRows}</ul>
    <p><strong>Total: ${currency} ${total}</strong></p>
    ${addressHtml ? `<p><strong>Shipping to:</strong><br>${addressHtml}</p>` : ''}
    ${trackingHtml}
    <p style="color:#666;font-size:13px;margin-top:24px;">Questions about your order? Just reply to this email — we're at orders@trendycatch.us.</p>
  </div>`
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)
  if (!env.RESEND_API_KEY) {
    return reply({ error: 'Email sending isn\'t set up yet — add a RESEND_API_KEY secret in Cloudflare Pages and verify trendycatch.us with Resend to enable this.' }, 503)
  }

  let input: any
  try { input = await request.json() } catch { return reply({ error: 'Invalid request' }, 400) }
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) return reply({ error: 'Invalid order' }, 400)

  const order = await env.ORDERS_DB
    .prepare('SELECT id, created_at, customer_name, customer_email, shipping_name, shipping_address_json, currency, total_minor, fulfillment_status, tracking_number, tracking_carrier, tracking_url FROM orders WHERE id = ?')
    .bind(input.id)
    .first()
  if (!order) return reply({ error: 'Order not found' }, 404)
  const customerEmail = order.customer_email
  if (!customerEmail || typeof customerEmail !== 'string') return reply({ error: 'This order has no customer email on file' }, 400)

  const itemsResult = await env.ORDERS_DB.prepare('SELECT title, variant, quantity, unit_amount_minor FROM order_items WHERE order_id = ? ORDER BY id').bind(input.id).all()
  const items = (itemsResult.results || []) as Array<Record<string, unknown>>

  const html = buildEmailHtml(order as Record<string, unknown>, items)

  let resendResponse: Response
  try {
    resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: 'TrendyCatch <orders@trendycatch.us>',
        to: [customerEmail],
        subject: `Your TrendyCatch order ${order.id} confirmation`,
        html,
      }),
    })
  } catch {
    return reply({ error: 'Could not reach the email provider. Try again shortly.' }, 502)
  }
  if (!resendResponse.ok) {
    const detail = await resendResponse.text().catch(() => '')
    return reply({ error: `Email provider declined to send (status ${resendResponse.status}).`, detail: detail.slice(0, 300) }, 502)
  }

  const now = new Date().toISOString()
  await env.ORDERS_DB
    .prepare('INSERT INTO order_events (order_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)')
    .bind(input.id, 'confirmation_email_sent', now, JSON.stringify({ to: customerEmail }))
    .run()

  return reply({ ok: true })
}
