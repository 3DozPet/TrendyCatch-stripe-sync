// Cloudflare Pages Function: POST /stripe-order-sync
// Webhook endpoint for Stripe account #1 (the account already wired into
// trendycatch.us). All the actual work — D1 order history, Shopify order
// creation, admin dashboard feed, ad-platform purchase events — lives in
// _lib/stripe-sync-core.ts, shared with account #2's endpoint
// (stripe-order-sync-2.ts). This file only supplies account #1's own
// secret key + webhook secret.
import { handleStripeOrderSync, type CoreEnv } from "./_lib/stripe-sync-core"

interface Env extends CoreEnv {
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return handleStripeOrderSync(request, env, {
    accountKey: "1",
    accountLabel: "TrendyCatch",
    stripeSecretKey: env.STRIPE_SECRET_KEY,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET,
  })
}
