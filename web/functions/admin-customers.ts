// GET /admin-customers
// Aggregates the orders table by customer_email so the dashboard's
// Customers section can show, per customer: name, phone, number of
// orders, lifetime spend, and when they last ordered. Read-only;
// mirrors the guard pattern used by admin-order-history.ts.

import { hasValidSession } from './_lib/auth'

interface Env { ORDERS_KV?: KVNamespace; ORDERS_DB?: D1Database }

const reply = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)

  const result = await env.ORDERS_DB.prepare(
    `SELECT
       customer_email AS email,
       MAX(customer_name) AS name,
       MAX(customer_phone) AS phone,
       COUNT(*) AS orderCount,
       SUM(total_minor) AS totalSpentMinor,
       MAX(currency) AS currency,
       MAX(created_at) AS lastOrderAt,
       MIN(created_at) AS firstOrderAt
     FROM orders
     WHERE customer_email IS NOT NULL AND customer_email != ''
     GROUP BY customer_email
     ORDER BY lastOrderAt DESC
     LIMIT 200`
  ).all()

  return reply({ customers: result.results || [], limit: 200 })
}
