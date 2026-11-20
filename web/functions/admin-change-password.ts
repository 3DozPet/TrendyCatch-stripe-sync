// POST /admin-change-password — requires an active session AND the correct
// current password before setting a new one.
import { hasValidSession, verifyPassword, setPassword } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return json({ error: "Not logged in." }, 401)

  let body: { currentPassword?: string; newPassword?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore, validated below
  }
  const current = (body.currentPassword || "").toString()
  const next = (body.newPassword || "").toString()

  if (!(await verifyPassword(env.ORDERS_KV, current))) {
    return json({ error: "Current password is incorrect." }, 401)
  }
  if (next.length < 8) return json({ error: "New password must be at least 8 characters." }, 400)

  await setPassword(env.ORDERS_KV, next)
  return json({ ok: true })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}
