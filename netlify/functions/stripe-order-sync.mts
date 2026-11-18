import type { Config, Context } from "@netlify/functions"
import Stripe from "stripe"

// Stripe payment -> Shopify order, straight away, no manual draft step.
// Listens for checkout.session.completed, pulls the real customer/shipping/line-item
// data from Stripe, and creates a PAID, unfulfilled order directly on 3Doz.pet via
// the Admin GraphQL API, tagged "TrendyCatch" + "stripe-auto-sync".

const SHOPIFY_API_VERSION = "2025-01"

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response("Method not allowed", { status: 405 })
  }

  const stripeSecretKey = Netlify.env.get("STRIPE_SECRET_KEY")
  const stripeWebhookSecret = Netlify.env.get("STRIPE_WEBHOOK_SECRET")
  const shopDomain = Netlify.env.get("SHOPIFY_STORE_DOMAIN") // e.g. 3doz.myshopify.com
  const shopifyToken = Netlify.env.get("SHOPIFY_ADMIN_TOKEN")
  const orderEmail = Netlify.env.get("ORDER_EMAIL") ?? "support@3doz.pet"

  if (!stripeSecretKey || !stripeWebhookSecret || !shopDomain || !shopifyToken) {
    console.error("Missing required environment variable(s)")
    return new Response("Server misconfigured", { status: 500 })
  }

  const stripe = new Stripe(stripeSecretKey)

  const signature = req.headers.get("stripe-signature")
  const rawBody = await req.text()

  let event: Stripe.Event
  try {
    if (!signature) throw new Error("Missing stripe-signature header")
    event = stripe.webhooks.constructEvent(rawBody, signature, stripeWebhookSecret)
  } catch (err) {
    console.error("Stripe signature verification failed:", (err as Error).message)
    return new Response("Invalid signature", { status: 400 })
  }

  if (event.type !== "checkout.session.completed") {
    // Not an event we act on; acknowledge so Stripe stops retrying it.
    return new Response("ignored", { status: 200 })
  }

  const sessionSummary = event.data.object as Stripe.Checkout.Session

  if (sessionSummary.payment_status !== "paid") {
    return new Response("not paid yet", { status: 200 })
  }

  // Re-fetch with line items expanded; the webhook payload alone doesn't include them.
  const session = await stripe.checkout.sessions.retrieve(sessionSummary.id, {
    expand: ["line_items.data.price.product", "customer_details"],
  })

  const tagSessionId = `stripe-${session.id}`.replace(/[^a-zA-Z0-9_-]/g, "")
  const orderTags = ["TrendyCatch", "stripe-auto-sync", tagSessionId]

  try {
    const already = await shopifyGraphql(
      shopDomain,
      shopifyToken,
      `query DuplicateCheck($q: String!) {
        orders(first: 1, query: $q) { edges { node { id name } } }
      }`,
      { q: `tag:${tagSessionId}` },
    )
    const existing = already?.data?.orders?.edges?.[0]
    if (existing) {
      console.log(`Order already synced for ${session.id}: ${existing.node.name}`)
      return new Response("duplicate, skipped", { status: 200 })
    }
  } catch (err) {
    console.error("Duplicate check failed, proceeding anyway:", (err as Error).message)
  }

  const customerDetails = session.customer_details
  const shipping = session.shipping_details ?? customerDetails
  const fullName = shipping?.name ?? customerDetails?.name ?? "Unknown customer"
  const [firstName, ...rest] = fullName.trim().split(/\s+/)
  const lastName = rest.join(" ") || firstName
  const addr = shipping?.address ?? customerDetails?.address

  const mailingAddress = addr
    ? {
        firstName,
        lastName,
        address1: addr.line1 ?? "",
        address2: addr.line2 ?? undefined,
        city: addr.city ?? "",
        provinceCode: addr.state ?? undefined,
        zip: addr.postal_code ?? "",
        countryCode: addr.country ?? "AU",
        phone: customerDetails?.phone ?? undefined,
      }
    : undefined

  const lineItems = (session.line_items?.data ?? []).map((li) => {
    const unitAmount = (li.price?.unit_amount ?? 0) / 100
    const product = li.price?.product
    const productTitle =
      typeof product === "object" && product && "name" in product
        ? (product as Stripe.Product).name
        : li.description ?? "Item"
    return {
      title: productTitle,
      quantity: li.quantity ?? 1,
      requiresShipping: true,
      taxable: true,
      priceSet: {
        shopMoney: {
          amount: unitAmount.toFixed(2),
          currencyCode: (session.currency ?? "aud").toUpperCase(),
        },
      },
    }
  })

  // Note: tags are deliberately NOT set on orderCreate itself. Shopify's
  // orderCreate mutation intermittently rejects a perfectly valid tags array
  // with a generic "Order tags is invalid" userError (a known platform quirk).
  // The reliable fix is to create the order untagged, then tag it right after
  // with a separate tagsAdd mutation.
  const orderInput = {
    email: orderEmail,
    phone: mailingAddress?.phone,
    financialStatus: "PAID",
    shippingAddress: mailingAddress,
    billingAddress: mailingAddress,
    lineItems,
    note: `Auto-synced from Stripe checkout ${session.id}. Customer email: ${
      customerDetails?.email ?? "unknown"
    }`,
    sourceName: "stripe",
    processedAt: new Date((session.created ?? Date.now() / 1000) * 1000).toISOString(),
  }

  const mutation = `mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
    orderCreate(order: $order, options: $options) {
      order { id name }
      userErrors { field message }
    }
  }`

  const result = await shopifyGraphql(shopDomain, shopifyToken, mutation, {
    order: orderInput,
    options: { sendReceipt: false, sendFulfillmentReceipt: false },
  })

  const userErrors = result?.data?.orderCreate?.userErrors ?? []
  if (userErrors.length > 0) {
    console.error("Shopify orderCreate userErrors:", JSON.stringify(userErrors))
    return new Response(`Shopify rejected the order: ${JSON.stringify(userErrors)}`, {
      status: 502,
    })
  }

  const createdOrder = result?.data?.orderCreate?.order
  console.log(`Created Shopify order ${createdOrder?.name} for Stripe session ${session.id}`)

  if (createdOrder?.id) {
    try {
      const tagResult = await shopifyGraphql(
        shopDomain,
        shopifyToken,
        `mutation AddOrderTags($id: ID!, $tags: [String!]!) {
          tagsAdd(id: $id, tags: $tags) {
            userErrors { field message }
          }
        }`,
        { id: createdOrder.id, tags: orderTags },
      )
      const tagErrors = tagResult?.data?.tagsAdd?.userErrors ?? []
      if (tagErrors.length > 0) {
        console.error("tagsAdd userErrors:", JSON.stringify(tagErrors))
      }
    } catch (err) {
      console.error("tagsAdd failed (order was still created):", (err as Error).message)
    }
  }

  return new Response(JSON.stringify({ ok: true, order: createdOrder }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

async function shopifyGraphql(
  shopDomain: string,
  token: string,
  query: string,
  variables: Record<string, unknown>,
) {
  const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Shopify-Access-Token": token,
    },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) {
    const text = await res.text()
    throw new Error(`Shopify API error ${res.status}: ${text}`)
  }
  return res.json()
}

export const config: Config = {
  path: "/stripe-order-sync",
  method: ["POST"],
}
