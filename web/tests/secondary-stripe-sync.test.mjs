import assert from 'node:assert/strict'
import { createHmac } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { stripTypeScriptTypes } from 'node:module'
import * as stripeOrders from '../functions/_lib/stripe-orders.ts'

function loadRoute(name, dependencies) {
  const source = readFileSync(new URL(`../functions/${name}.ts`, import.meta.url), 'utf8')
    .replace(/^import .*$/gm, '').replace('export const', 'const')
  return new Function(...Object.keys(dependencies), stripTypeScriptTypes(source) + '; return onRequestPost')(...Object.values(dependencies))
}

const orders = new Set()
const writes = {
  recordOrderHistory: async (_db, session) => orders.add(session.id),
}
const secondaryWebhook = loadRoute('stripe-order-sync-secondary', { ...stripeOrders, ...writes })
const backfill = loadRoute('admin-backfill-stripe', { ...stripeOrders, ...writes, hasValidSession: async () => true })

const primary = { id: 'cs_live_primary', payment_status: 'paid', livemode: true }
const secondary = { id: 'cs_live_secondary', payment_status: 'paid', livemode: true }
const test = { id: 'cs_test_checkout', payment_status: 'paid', livemode: false }
const unpaid = { id: 'cs_live_unpaid', payment_status: 'unpaid', livemode: true }
const keys = { primary: [primary], secondary: [secondary, unpaid, test] }
const apiCalls = []
globalThis.fetch = async (url, options) => {
  const key = options.headers.Authorization.replace('Bearer ', '')
  const path = new URL(url).pathname
  apiCalls.push({ key, path })
  if (!(key in keys)) return new Response('{}', { status: 401 })
  if (path === '/v1/checkout/sessions') return Response.json({ data: keys[key] })
  const session = keys[key].find(session => path.endsWith('/' + session.id))
  return session ? Response.json(session) : new Response('{}', { status: 404 })
}

const env = {
  ORDERS_DB: {}, ORDERS_KV: {},
  STRIPE_SECRET_KEY: 'primary',
  STRIPE_SECONDARY_SECRET_KEY: 'secondary',
  STRIPE_SECONDARY_WEBHOOK_SECRET: 'secondary-signing-secret',
}

function delivery(session, secret = env.STRIPE_SECONDARY_WEBHOOK_SECRET, age = 0) {
  const body = JSON.stringify({ type: 'checkout.session.async_payment_succeeded', livemode: session.livemode, data: { object: session } })
  const timestamp = Math.floor(Date.now() / 1000) - age
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')
  return new Request('https://preview.example/stripe-order-sync-secondary', {
    method: 'POST', body, headers: { 'stripe-signature': `t=${timestamp},v1=${signature},v1=${'0'.repeat(64)}` },
  })
}

assert.equal((await secondaryWebhook({ env, request: delivery(secondary, 'other-signing-secret') })).status, 400)
assert.equal((await secondaryWebhook({ env, request: delivery(secondary, undefined, 301) })).status, 400)
assert.equal((await secondaryWebhook({ env, request: delivery(test) })).status, 200)
assert.equal((await secondaryWebhook({ env, request: delivery(unpaid) })).status, 200)
assert.equal(apiCalls.length, 0)
assert.equal((await secondaryWebhook({ env, request: delivery(secondary) })).status, 200)
assert.deepEqual(apiCalls[0], { key: 'secondary', path: '/v1/checkout/sessions/cs_live_secondary' })
assert.deepEqual([...orders], [secondary.id])

const syncRequest = () => new Request('https://preview.example/admin-backfill-stripe', {
  method: 'POST', headers: { Origin: 'https://preview.example' },
})
let result = await (await backfill({ env, request: syncRequest() })).json()
assert.equal(result.ok, true)
assert.equal(result.written, 2)
assert.deepEqual([...orders].sort(), [primary.id, secondary.id])
orders.clear()
result = await (await backfill({
  env: { ...env, STRIPE_SECONDARY_SECRET_KEY: 'invalid' }, request: syncRequest(),
})).json()
assert.equal(result.ok, false)
assert.match(result.failures[0], /Secondary.*401/)
assert.deepEqual([...orders], [primary.id])
