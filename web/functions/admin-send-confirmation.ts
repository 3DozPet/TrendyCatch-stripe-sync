import { hasValidSession } from './_lib/auth'
import { sendOrderEmail } from './_lib/order-email'

interface Env { ORDERS_KV?: KVNamespace; ORDERS_DB?: D1Database; RESEND_API_KEY?: string }
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } })

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !env.ORDERS_DB) return reply({ error: 'Order storage is not configured' }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return reply({ error: 'Unauthorized' }, 401)
  const origin = request.headers.get('Origin')
  if (!origin || origin !== new URL(request.url).origin) return reply({ error: 'Invalid request origin' }, 403)

  let input: any
  try { input = await request.json() } catch { return reply({ error: 'Invalid request' }, 400) }
  if (typeof input.id !== 'string' || !/^[a-zA-Z0-9_-]{1,100}$/.test(input.id)) return reply({ error: 'Invalid order' }, 400)

  const result = await sendOrderEmail(env, input.id, 'confirmation')
  if (!result.ok) return reply({ error: result.error || 'Unable to send confirmation email' }, result.error === 'Order not found' ? 404 : 502)
  return reply({ ok: true })
}
