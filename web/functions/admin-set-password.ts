// POST /admin-set-password — only works when no password exists yet (the
// first-visit "create your password" flow). Once a password is set, this
// endpoint always refuses; change-password is the only way to update it
// after that, and it requires the current password.
import { hasPasswordSet, setPassword, createSessionCookie } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
  ADMIN_SETUP_TOKEN?: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)

  if (!env.ADMIN_SETUP_TOKEN || env.ADMIN_SETUP_TOKEN.length < 24) return json({ error: "Admin setup is not configured." }, 503)

  if (await hasPasswordSet(env.ORDERS_KV)) {
    return json({ error: "A password is already set. Use the change-password option instead." }, 403)
  }

  let body: { password?: string; setupToken?: string; username?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore, validated below
  }
  const token = (body.setupToken || "").toString()
  const encoder = new TextEncoder()
  const expected = await crypto.subtle.digest("SHA-256", encoder.encode(env.ADMIN_SETUP_TOKEN))
  const supplied = await crypto.subtle.digest("SHA-256", encoder.encode(token))
  const a = new Uint8Array(expected), b = new Uint8Array(supplied)
  let diff = 0
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i]
  if (diff !== 0 || (body.username || "").trim().toLowerCase() !== "robbie@trendycatch.us") return json({ error: "Invalid setup credentials." }, 403)
  const password = (body.password || "").toString()
  if (password.length < 8) {
    return json({ error: "Password must be at least 8 characters." }, 400)
  }

  await setPassword(env.ORDERS_KV, password)
  const cookie = await createSessionCookie(env.ORDERS_KV)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}
