import type { Config, Context } from "@netlify/functions"
import Stripe from "stripe"
import { createHash } from "node:crypto"

// Stripe payment -> Shopify order, straight away, no manual draft step.
// Listens for checkout.session.completed, pulls the real customer/shipping/line-item
// data from Stripe, and creates a PAID, unfulfilled order directly on 3Doz.pet via
// the Admin GraphQL API, tagged "TrendyCatch" + "stripe-auto-sync".

const SHOPIFY_API_VERSION = "2025-01"

// OrderCreateCustomerAddressInput.country wants the country's NAME, not its
// ISO code (unlike MailingAddressInput.countryCode used for shippingAddress/
// billingAddress, which does want the code). Map the markets 3Doz.pet/
// TrendyCatch actually sell to; fall back to the raw code for anything else.
const COUNTRY_NAMES: Record<string, string> = {
  AU: "Australia",
  NZ: "New Zealand",
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
}

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

  // Shopify order tags have a hard 40-character limit per tag. The raw Stripe
  // session id (e.g. "cs_live_a0bvlPP39DTd77AjcZnYFPPDPzUupX0jsMRuZTWwWkGOS1c6mMAKPNpwLG")
  // is 60-70+ characters, so a tag built directly from it is always silently
  // rejected by Shopify with a generic "Order tags is invalid" error. Use a
  // short, deterministic hash of the session id instead so the tag stays
  // well under the limit while remaining unique per session (for dedupe).
  const sessionIdHash = createHash("sha256").update(session.id).digest("hex").slice(0, 16)
  const tagSessionId = `stripe-${sessionIdHash}`
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

  // Attach (or create/update) a real Shopify Customer on the order, instead of
  // leaving it unset. Without this, Shopify either leaves the order with no
  // linked customer or auto-creates a blank one, so the admin's "Customer"
  // column and the customer profile don't show who actually placed the order.
  // toUpsert matches an existing customer by email when one exists, otherwise
  // creates a new one with this name/address.
  const customerInput = customerDetails?.email
    ? {
        toUpsert: {
          email: customerDetails.email,
          firstName,
          lastName,
          phone: customerDetails?.phone ?? undefined,
          addresses: addr
            ? [
                {
                  firstName,
                  lastName,
                  address1: addr.line1 ?? "",
                  address2: addr.line2 ?? undefined,
                  city: addr.city ?? "",
                  province: addr.state ?? undefined,
                  zip: addr.postal_code ?? "",
                  country: addr.country ? COUNTRY_NAMES[addr.country] ?? addr.country : "Australia",
                  phone: customerDetails?.phone ?? undefined,
                },
              ]
            : undefined,
        },
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

  // The Stripe checkout session's currency (session.currency) is whatever the
  // customer actually paid in - AUD, USD, NZD, CAD, etc, since TrendyCatch/
  // 3Doz.pet sells to multiple countries. Shopify requires the order's own
  // "currency"/"presentmentCurrency" to be declared explicitly whenever that
  // differs from the shop's base currency; without it, orderCreate rejects
  // the whole order with "Line items currency must be provided when either
  // order currency or order presentment currency is different from the shop
  // currency" - which is why some non-AUD orders weren't syncing at all.
  const orderCurrency = (session.currency ?? "aud").toUpperCase()

  // Note: tags are deliberately NOT set on orderCreate itself. Shopify's
  // orderCreate mutation intermittently rejects a tags array with a generic
  // "Order tags is invalid" userError whenever any tag exceeds Shopify's
  // 40-character-per-tag limit (see tagSessionId above for why that mattered
  // here). Creating the order untagged, then tagging it right after with a
  // separate tagsAdd mutation, keeps order creation itself from ever failing
  // because of a tag problem.
  const orderInput = {
    email: orderEmail,
    phone: mailingAddress?.phone,
    financialStatus: "PAID",
    currency: orderCurrency,
    presentmentCurrency: orderCurrency,
    customer: customerInput,
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
