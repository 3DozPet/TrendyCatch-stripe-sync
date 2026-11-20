// POST /admin-set-password — only works when no password exists yet (the
// first-visit "create your password" flow). Once a password is set, this
// endpoint always refuses; change-password is the only way to update it
// after that, and it requires the current password.
import { hasPasswordSet, setPassword, createSessionCookie } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)

  if (await hasPasswordSet(env.ORDERS_KV)) {
    return json({ error: "A password is already set. Use the change-password option instead." }, 403)
  }

  let body: { password?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore, validated below
  }
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
