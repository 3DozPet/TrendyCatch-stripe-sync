import type { Config } from "@netlify/functions"
import Stripe from "stripe"
import { createHash } from "node:crypto"

// Independent PureGlow purchase reporting. This endpoint does not create orders.
const PUREGLOW_LINKS = new Set([
  "plink_1UeO0KJZyoWnWjYgk1lewwP5",
  "plink_1UdRbeJZyoWnWjYgZ0ACNRv4",
  "plink_1UdRbeJZyoWnWjYgamZYlw2o",
  "plink_1UdRbeJZyoWnWjYgymRHFFEg",
])
const DATASET_ID = "1132252676368437"

export default async (req: Request) => {
  const webhookSecret = Netlify.env.get("PUREGLOW_STRIPE_WEBHOOK_SECRET")
  const accessToken = Netlify.env.get("PUREGLOW_META_CAPI_ACCESS_TOKEN")
  if (!webhookSecret || !accessToken) return new Response("Missing configuration", { status: 503 })

  const signature = req.headers.get("stripe-signature")
  if (!signature) return new Response("Missing signature", { status: 400 })

  let event: Stripe.Event
  try {
    // The SDK is only used for offline signature verification; no Stripe API request is made.
    const stripe = new Stripe("sk_test_unused")
    event = stripe.webhooks.constructEvent(await req.text(), signature, webhookSecret)
  } catch {
    return new Response("Invalid signature", { status: 400 })
  }

  if (!event.livemode || event.type !== "checkout.session.completed")
    return new Response("Ignored", { status: 200 })

  const session = event.data.object as Stripe.Checkout.Session
  const link = typeof session.payment_link === "string" ? session.payment_link : session.payment_link?.id
  if (!link || !PUREGLOW_LINKS.has(link) || session.payment_status !== "paid")
    return new Response("Ignored", { status: 200 })

  if (!session.currency || session.amount_total == null || !session.id)
    return new Response("Missing purchase details", { status: 422 })

  const hash = (value: string) => createHash("sha256").update(value).digest("hex")
  const email = session.customer_details?.email?.trim().toLowerCase()
  const phone = session.customer_details?.phone?.replace(/\\D/g, "")
  const userData = {
    em: email ? [hash(email)] : undefined,
    ph: phone ? [hash(phone)] : undefined,
  }
  if (!email && !phone) return new Response("Missing customer match data", { status: 422 })

  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${DATASET_ID}/events`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        access_token: accessToken,
        data: [{
          event_name: "Purchase",
          event_time: event.created,
          event_id: session.id,
          action_source: "website",
          event_source_url: "https://pureglow-clearance.netlify.app/",
          user_data: userData,
          custom_data: {
            currency: session.currency.toUpperCase(),
            value: session.amount_total / 100,
            content_type: "product",
            content_ids: ["PUREGLOW-PATCH-50"],
          },
        }],
      }),
    })
    const result = await response.json()
    if (!response.ok || result.error || result.events_received !== 1) {
      console.error("PureGlow Meta event was not accepted", response.status, result.error?.code)
      return new Response("Meta event failed", { status: 502 })
    }
    return new Response("Purchase sent", { status: 200 })
  } catch {
    return new Response("Meta request failed", { status: 502 })
  }
}

export const config: Config = { path: "/pureglow-meta-purchase", method: ["POST"] }
