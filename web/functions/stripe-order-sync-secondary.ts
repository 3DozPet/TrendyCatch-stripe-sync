import { fetchFullCheckoutSession, recordOrderHistory, verifyStripeSignature } from './_lib/stripe-orders'

interface Env {
  ORDERS_DB?: D1Database
  STRIPE_SECONDARY_SECRET_KEY?: string
  STRIPE_SECONDARY_WEBHOOK_SECRET?: string
}

// This account's checkout and downstream integrations are managed separately.
export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  const apiKey = env.STRIPE_SECONDARY_SECRET_KEY?.trim()
  const signingSecret = env.STRIPE_SECONDARY_WEBHOOK_SECRET?.trim()
  if (!env.ORDERS_DB || !apiKey || !signingSecret) {
    return new Response('Stripe order storage is not configured', { status: 503 })
  }

  const signature = request.headers.get('stripe-signature')
  if (!signature) return new Response('Missing signature', { status: 400 })

  let event: any
  try {
    event = await verifyStripeSignature(await request.text(), signature, signingSecret)
  } catch {
    return new Response('Invalid signature', { status: 400 })
  }

  const summary = event?.data?.object
  if (event?.livemode !== true || !['checkout.session.completed', 'checkout.session.async_payment_succeeded'].includes(event.type)
    || summary?.payment_status !== 'paid' || typeof summary.id !== 'string' || !/^cs_live_[A-Za-z0-9]+$/.test(summary.id)) {
    return new Response('Ignored')
  }

  try {
    const session = await fetchFullCheckoutSession(apiKey, summary.id)
    if (session.livemode !== true || session.payment_status !== 'paid') return new Response('Ignored')
    await recordOrderHistory(env.ORDERS_DB, session)
  } catch {
    return new Response('Stripe order sync unavailable', { status: 503 })
  }

  return new Response('Order synced')
}
