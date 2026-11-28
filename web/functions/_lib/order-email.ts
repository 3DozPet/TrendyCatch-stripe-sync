// Shared order-email helper. Builds the same order-detail email (items,
// address, tracking when present) and sends it via Resend, whether triggered
// manually ("Send order confirmation" button, admin-send-confirmation.ts) or
// automatically (saving a tracking number/fulfilment status,
// admin-order-history.ts). Pulled out so both call sites stay in sync instead
// of drifting into two slightly-different email templates.

export interface OrderEmailEnv {
  ORDERS_DB?: D1Database
  RESEND_API_KEY?: string
}

export type OrderEmailKind = 'confirmation' | 'shipped'

export interface OrderEmailResult {
  ok: boolean
  skipped?: boolean
  error?: string
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' } as Record<string, string>)[c])
}

function buildEmailHtml(order: Record<string, unknown>, items: Array<Record<string, unknown>>, kind: OrderEmailKind): string {
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

  // Deliberately plain text, no link and no carrier name: the 17TRACK page
  // (or the carrier's own tracking page) shows the full checkpoint history,
  // which for a dropshipped order includes the overseas origin — exactly
  // what this email must not expose to the customer. Just the number itself,
  // so a customer who wants to track it has to go look it up themselves.
  let trackingHtml = ''
  if (order.fulfillment_status === 'fulfilled' && order.tracking_number) {
    trackingHtml = `<p>Tracking number: <strong>${escapeHtml(String(order.tracking_number))}</strong></p>`
  }

  const heading = kind === 'shipped'
    ? `Your order${order.customer_name ? ', ' + escapeHtml(String(order.customer_name)) : ''} is on its way!`
    : `Thanks for your order${order.customer_name ? ', ' + escapeHtml(String(order.customer_name)) : ''}!`

  return `<div style="font-family:Arial,Helvetica,sans-serif;max-width:480px;margin:0 auto;color:#222;">
    <h2 style="margin-bottom:4px;">${heading}</h2>
    <p style="color:#666;margin-top:0;">Order ${escapeHtml(String(order.id))}${order.created_at ? ' · ' + escapeHtml(String(order.created_at)) : ''}</p>
    <ul style="padding-left:18px;">${itemRows}</ul>
    <p><strong>Total: ${currency} ${total}</strong></p>
    ${addressHtml ? `<p><strong>Shipping to:</strong><br>${addressHtml}</p>` : ''}
    ${trackingHtml}
    <p style="color:#666;font-size:13px;margin-top:24px;">Questions about your order? Just reply to this email — we're at orders@trendycatch.us.</p>
  </div>`
}

// Fetches the order + items from D1, builds the email, sends it via Resend,
// and records an order_events row. Never throws — every failure mode (no
// Resend key, no customer email on file, Resend rejecting the request)
// comes back as { ok: false, error }, so callers that trigger this
// automatically (e.g. saving a tracking number) can treat it as best-effort
// and still report success on the underlying save.
export async function sendOrderEmail(env: OrderEmailEnv, orderId: string, kind: OrderEmailKind): Promise<OrderEmailResult> {
  if (!env.ORDERS_DB) return { ok: false, skipped: true, error: 'Order storage is not configured' }
  if (!env.RESEND_API_KEY) {
    return { ok: false, skipped: true, error: 'Email sending isn\'t set up yet — add a RESEND_API_KEY secret in Cloudflare Pages and verify trendycatch.us with Resend to enable this.' }
  }

  const order = await env.ORDERS_DB
    .prepare('SELECT id, created_at, customer_name, customer_email, shipping_name, shipping_address_json, currency, total_minor, fulfillment_status, tracking_number, tracking_carrier, tracking_url FROM orders WHERE id = ?')
    .bind(orderId)
    .first()
  if (!order) return { ok: false, error: 'Order not found' }
  const customerEmail = order.customer_email
  if (!customerEmail || typeof customerEmail !== 'string') return { ok: false, skipped: true, error: 'This order has no customer email on file' }

  const itemsResult = await env.ORDERS_DB.prepare('SELECT title, variant, quantity, unit_amount_minor FROM order_items WHERE order_id = ? ORDER BY id').bind(orderId).all()
  const items = (itemsResult.results || []) as Array<Record<string, unknown>>

  const html = buildEmailHtml(order as Record<string, unknown>, items, kind)
  const subject = kind === 'shipped'
    ? `Your TrendyCatch order ${order.id} has shipped`
    : `Your TrendyCatch order ${order.id} confirmation`

  let resendResponse: Response
  try {
    resendResponse = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: 'TrendyCatch <orders@trendycatch.us>', to: [customerEmail], subject, html }),
    })
  } catch {
    return { ok: false, error: 'Could not reach the email provider. Try again shortly.' }
  }
  if (!resendResponse.ok) {
    const detail = await resendResponse.text().catch(() => '')
    return { ok: false, error: `Email provider declined to send (status ${resendResponse.status}): ${detail.slice(0, 300)}` }
  }

  // Store the subject + rendered html alongside the log entry (not just who
  // it went to) so the admin dashboard's Sent Emails panel can show exactly
  // what the customer received, not just that something was sent.
  const now = new Date().toISOString()
  await env.ORDERS_DB
    .prepare('INSERT INTO order_events (order_id, event_type, created_at, detail_json) VALUES (?, ?, ?, ?)')
    .bind(orderId, kind === 'shipped' ? 'shipping_email_sent' : 'confirmation_email_sent', now, JSON.stringify({ to: customerEmail, subject, html }))
    .run()

  return { ok: true }
}
