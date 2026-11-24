// Cloudflare Pages Function: POST /stripe-order-sync-2
// Webhook endpoint for the SECOND Stripe account being added to this
// dashboard. Point that account's own webhook (in its own Stripe dashboard,
// Developers -> Webhooks -> Add endpoint) at:
//   https://trendycatch.us/stripe-order-sync-2
// subscribed to the "checkout.session.completed" event, the same as account
// #1. Needs its own two Cloudflare Pages environment variables set
// (Settings -> Environment variables on the Pages project):
//   STRIPE_SECRET_KEY_2     — account #2's API secret key (sk_live_...)
//   STRIPE_WEBHOOK_SECRET_2 — the signing secret for the endpoint above (whsec_...)
// Everything else (Shopify store, ad pixels, KV) is shared with account #1 —
// see _lib/stripe-sync-core.ts for the logic both endpoints run.
import { handleStripeOrderSync, type CoreEnv } from "./_lib/stripe-sync-core"

interface Env extends CoreEnv {
  STRIPE_SECRET_KEY_2: string
  STRIPE_WEBHOOK_SECRET_2: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  return handleStripeOrderSync(request, env, {
    accountKey: "2",
    // Assumption: labeled generically since the account's specific purpose
    // wasn't given. Rename this (and the badge color in admin.html) once
    // you tell me what it's for.
    accountLabel: "TrendyCatch (Account 2)",
    stripeSecretKey: env.STRIPE_SECRET_KEY_2,
    stripeWebhookSecret: env.STRIPE_WEBHOOK_SECRET_2,
  })
}
