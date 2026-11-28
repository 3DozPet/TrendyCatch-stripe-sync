// GET /customer-orders — the customer-facing order list, gated by the
// signed session cookie from customer-session.ts. Unlike the admin
// endpoints, this is reachable without a password, so it's deliberately
// narrow: it can only ever return orders whose customer_email matches the
// signed-in session's own email (bound into a parameterised query — never
// string-built), and it never includes the raw Stripe checkout session ID,
// customer phone, or billing address — just enough for a customer to see
// what they ordered and whether it's shipped.

import { getCustomerSession } from "./_lib/customer-auth"

interface Env {
  ORDERS_KV?: KVNamespace
  ORDERS_DB?: D1Database
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return json({ error: "Server not configured." }, 500)

  const email = await getCustomerSession(request, env.ORDERS_KV)
  if (!email) return json({ error: "Please sign in to see your orders." }, 401)

  const orders = await env.ORDERS_DB.prepare(
    `WITH numbered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS order_number FROM orders)
     SELECT o.id, o.created_at, o.currency, o.total_minor, o.fulfillment_status, o.tracking_number, n.order_number
     FROM orders o JOIN numbered n ON n.id = o.id
     WHERE LOWER(o.customer_email) = ?
     ORDER BY o.created_at DESC`
  ).bind(email).all()

  const orderRows = (orders.results || []) as Array<Record<string, unknown>>
  const ids = orderRows.map((o) => o.id)
  let items: Array<Record<string, unknown>> = []
  if (ids.length) {
    const placeholders = ids.map(() => "?").join(",")
    const itemsResult = await env.ORDERS_DB
      .prepare(`SELECT order_id, title, variant, quantity, image_url FROM order_items WHERE order_id IN (${placeholders}) ORDER BY id`)
      .bind(...ids)
      .all()
    items = (itemsResult.results || []) as Array<Record<string, unknown>>
  }

  const result = orderRows.map((o) => ({
    orderNumber: o.order_number,
    createdAt: o.created_at,
    currency: o.currency,
    totalMinor: o.total_minor,
    fulfillmentStatus: o.fulfillment_status,
    trackingNumber: o.tracking_number || null,
    items: items.filter((i) => i.order_id === o.id).map((i) => ({ title: i.title, variant: i.variant, quantity: i.quantity, imageUrl: i.image_url })),
  }))

  return json({ email, orders: result })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
