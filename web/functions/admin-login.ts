// POST /admin-login — verifies the password and issues the session cookie.
// Throttled per-IP against brute-force guessing.
import { verifyPassword, createSessionCookie, isLockedOut, recordFailedAttempt, clearFailedAttempts } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)

  const ip = request.headers.get("cf-connecting-ip") || "unknown"
  if (await isLockedOut(env.ORDERS_KV, ip)) {
    return json({ error: "Too many attempts. Try again in a few minutes." }, 429)
  }

  let body: { password?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore, validated below
  }
  const password = (body.password || "").toString()

  const ok = await verifyPassword(env.ORDERS_KV, password)
  if (!ok) {
    await recordFailedAttempt(env.ORDERS_KV, ip)
    return json({ error: "Incorrect password." }, 401)
  }

  await clearFailedAttempts(env.ORDERS_KV, ip)
  const cookie = await createSessionCookie(env.ORDERS_KV)
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": cookie },
  })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}
