// GET /customer-session?token=... — step 2 of the magic-link flow. Called
// by my-orders.html right after the customer clicks the emailed link.
// Exchanges the one-time token for a signed session cookie. The token is
// consumed (deleted from KV) the moment it's read, so the same link can
// never be used twice — including by someone who later finds it sitting in
// an inbox or browser history.

import { consumeLoginToken, createCustomerSessionCookie } from "./_lib/customer-auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)

  const token = new URL(request.url).searchParams.get("token") || ""
  const email = token ? await consumeLoginToken(env.ORDERS_KV, token) : null
  if (!email) return json({ error: "That link has expired or was already used. Request a new one." }, 401)

  const cookie = await createCustomerSessionCookie(env.ORDERS_KV, email)
  return json({ ok: true, email }, 200, cookie)
}

function json(data: unknown, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" }
  if (setCookie) headers["set-cookie"] = setCookie
  return new Response(JSON.stringify(data), { status, headers })
}
