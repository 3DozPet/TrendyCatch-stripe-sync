// GET /admin-sent-emails — feeds the admin dashboard's "Sent emails" panel.
//
// Reads order_events rows written by sendOrderEmail() in
// _lib/order-email.ts (event_type 'confirmation_email_sent' /
// 'shipping_email_sent'), each of which now carries { to, subject, html } in
// detail_json. Without ?id, returns a light list (no html, to keep the
// payload small) newest first. With ?id=<order_events.id>, returns that one
// event's full html so the dashboard can render it in a preview iframe —
// i.e. exactly what the customer's inbox shows, not a guess at it.
//
// Gated exactly like every other admin-* endpoint: this is customer data,
// never public.
import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
  ORDERS_DB?: D1Database
}

const EMAIL_EVENT_TYPES = ["confirmation_email_sent", "shipping_email_sent"]

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) {
    return json({ emails: [], error: "Order storage is not configured" }, 200)
  }
  if (!(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }

  const url = new URL(request.url)
  const id = url.searchParams.get("id")

  // Same TC-000001-style order_number used in the Order history panel
  // (see admin-order-history.ts), joined in here so the sent-email log
  // doesn't show the raw Stripe session ID either.
  const NUMBERED_CTE = `WITH numbered AS (SELECT id, ROW_NUMBER() OVER (ORDER BY created_at ASC, id ASC) AS order_number FROM orders)`

  if (id) {
    const row = await env.ORDERS_DB
      .prepare(
        `${NUMBERED_CTE}
         SELECT oe.id, oe.order_id, oe.event_type, oe.created_at, oe.detail_json, o.customer_name, n.order_number
         FROM order_events oe LEFT JOIN orders o ON o.id = oe.order_id LEFT JOIN numbered n ON n.id = oe.order_id
         WHERE oe.id = ? AND oe.event_type IN (${EMAIL_EVENT_TYPES.map(() => "?").join(",")})`
      )
      .bind(id, ...EMAIL_EVENT_TYPES)
      .first()
    if (!row) return json({ error: "Email not found" }, 404)
    return json({ email: toEmailRecord(row, true) })
  }

  const limit = Math.min(Number(url.searchParams.get("limit") || "100") || 100, 200)
  const result = await env.ORDERS_DB
    .prepare(
      `${NUMBERED_CTE}
       SELECT oe.id, oe.order_id, oe.event_type, oe.created_at, oe.detail_json, o.customer_name, n.order_number
       FROM order_events oe LEFT JOIN orders o ON o.id = oe.order_id LEFT JOIN numbered n ON n.id = oe.order_id
       WHERE oe.event_type IN (${EMAIL_EVENT_TYPES.map(() => "?").join(",")})
       ORDER BY oe.created_at DESC LIMIT ?`
    )
    .bind(...EMAIL_EVENT_TYPES, limit)
    .all()

  const emails = (result.results || []).map((row) => toEmailRecord(row, false))
  return json({ emails })
}

function toEmailRecord(row: any, includeHtml: boolean): Record<string, unknown> {
  let detail: Record<string, unknown> = {}
  try {
    detail = row.detail_json ? JSON.parse(row.detail_json) : {}
  } catch {
    detail = {}
  }
  const record: Record<string, unknown> = {
    id: row.id,
    orderId: row.order_id,
    orderNumber: row.order_number ?? null,
    customer: row.customer_name || null,
    to: detail.to || null,
    subject: detail.subject || null,
    kind: row.event_type === "shipping_email_sent" ? "shipped" : "confirmation",
    sentAt: row.created_at,
    hasHtml: Boolean(detail.html),
  }
  if (includeHtml) record.html = detail.html || null
  return record
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
