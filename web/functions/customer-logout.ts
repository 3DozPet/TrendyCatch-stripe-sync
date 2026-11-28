// POST /customer-logout — clears the customer session cookie. Origin-
// checked like the other state-changing endpoints in this project, so a
// page on another site can't trigger it against a signed-in customer.

import { clearCustomerSessionCookie } from "./_lib/customer-auth"

export const onRequestPost: PagesFunction = async ({ request }) => {
  const origin = request.headers.get("Origin")
  if (!origin || origin !== new URL(request.url).origin) return json({ error: "Invalid request origin" }, 403)
  return json({ ok: true }, 200, clearCustomerSessionCookie())
}

function json(data: unknown, status = 200, setCookie?: string): Response {
  const headers: Record<string, string> = { "content-type": "application/json", "cache-control": "no-store" }
  if (setCookie) headers["set-cookie"] = setCookie
  return new Response(JSON.stringify(data), { status, headers })
}
