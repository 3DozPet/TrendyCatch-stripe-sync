import type { Config, Context } from "@netlify/functions"
import Stripe from "stripe"
import { createHash } from "node:crypto"

// Stripe payment -> Shopify order for the TrendyCatch "Home Gadget Essentials
// Bundle" landing page (trendycatch-bundle.netlify.app). Built as a SEPARATE,
// self-contained function from stripe-order-sync.mts and using ONLY
// BUNDLE_*-prefixed env vars (plus the store-level SHOPIFY_*/ORDER_EMAIL vars
// that are shared across every TrendyCatch/3Doz.pet product because they just
// point at the same destination Shopify store) so this can never touch or be
// affected by PureGlow's, LunaHug's, or any other product's configuration.
//
// Unlike stripe-order-sync.mts, this does NOT call back into the Stripe API
// to retrieve/expand the session - the bundle sells exactly one fixed
// product (no line-item variability), and every field needed (amount,
// currency, customer, shipping) is already present on the
// checkout.session.completed webhook payload itself, so no Stripe secret/API
// key is needed here at all, only the webhook signing secret to verify the
// request came from Stripe.
//
// Fires server-side Purchase events to TikTok Events API and Meta
// Conversions API right after the Shopify order is created. Each platform
// call is independently optional (skipped with a log line if its env vars
// aren't set) and independently try/caught, so a failure on one can never
// affect the Shopify order flow or the other platform.

const SHOPIFY_API_VERSION = "2025-01"
const BUNDLE_PRODUCT_NAME = "Home Gadget Essentials Bundle"
const BUNDLE_PRODUCT_CONTENT_ID = "trendycatch-bundle-1"

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

  const shopDomain = Netlify.env.get("SHOPIFY_STORE_DOMAIN")
  const shopifyToken = Netlify.env.get("SHOPIFY_ADMIN_TOKEN")
  const orderEmail = Netlify.env.get("ORDER_EMAIL") ?? "support@trendycatch.us"
  const webhookSecret = Netlify.env.get("BUNDLE_STRIPE_WEBHOOK_SECRET")
  const signature = req.headers.get("stripe-signature")
  const rawBody = await req.text()

  if (!signature) return new Response("Invalid signature", { status: 400 })
  if (!webhookSecret || !shopDomain || !shopifyToken) {
    console.error("Missing configuration (BUNDLE_STRIPE_WEBHOOK_SECRET/SHOPIFY_*) for bundle-order-sync")
    return new Response("Server misconfigured", { status: 500 })
  }

  let event: Stripe.Event
  try {
    event = Stripe.webhooks.constructEvent(rawBody, signature, webhookSecret)
  } catch (err) {
    console.error("Bundle webhook signature verification failed:", (err as Error).message)
    return new Response("Invalid signature", { status: 400 })
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("ignored", { status: 200 })
  }

  const session = event.data.object as Stripe.Checkout.Session

  if (session.payment_status !== "paid") {
    return new Response("not paid yet", { status: 200 })
  }

  // Same dedupe pattern as stripe-order-sync.mts: a short deterministic hash
  // of the session id, used both as the Shopify order tag (Shopify tags cap
  // at 40 chars; raw Stripe session ids are longer) and as the event_id for
  // ad-platform dedup.
  const sessionIdHash = createHash("sha256").update(session.id).digest("hex").slice(0, 16)
  const tagSessionId = `bundle-${sessionIdHash}`
  const orderTags = ["TrendyCatchBundle", "stripe-auto-sync", tagSessionId]

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
      console.log(`Bundle order already synced for ${session.id}: ${existing.node.name}`)
      return new Response("duplicate, skipped", { status: 200 })
    }
  } catch (err) {
    console.error("Bundle duplicate check failed, proceeding anyway:", (err as Error).message)
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

  const orderCurrency = (session.currency ?? "aud").toUpperCase()
  const unitAmount = (session.amount_total ?? 0) / 100

  const lineItems = [
    {
      title: BUNDLE_PRODUCT_NAME,
      quantity: 1,
      requiresShipping: true,
      taxable: true,
      priceSet: {
        shopMoney: {
          amount: unitAmount.toFixed(2),
          currencyCode: orderCurrency,
        },
      },
    },
  ]

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
    note: `Auto-synced from Stripe checkout ${session.id} (TrendyCatch bundle). Customer email: ${
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
    console.error("Bundle Shopify orderCreate userErrors:", JSON.stringify(userErrors))
    return new Response(`Shopify rejected the order: ${JSON.stringify(userErrors)}`, {
      status: 502,
    })
  }

  const createdOrder = result?.data?.orderCreate?.order
  console.log(`Created Shopify order ${createdOrder?.name} for bundle Stripe session ${session.id}`)

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
        console.error("Bundle tagsAdd userErrors:", JSON.stringify(tagErrors))
      }
    } catch (err) {
      console.error("Bundle tagsAdd failed (order was still created):", (err as Error).message)
    }
  }

  // ---------------------------------------------------------------------
  // Ad-platform purchase tracking - bundle-specific pixels only.
  // Additive and non-blocking: independently optional/try-caught per
  // platform, same as stripe-order-sync.mts.
  // ---------------------------------------------------------------------

  const purchaseValue = (session.amount_total ?? 0) / 100
  const landingUrl = "https://trendycatch-bundle.netlify.app"
  const clientIp = req.headers.get("x-forwarded-for") ?? undefined
  const clientUserAgent = req.headers.get("user-agent") ?? undefined

  const tiktokAccessToken = Netlify.env.get("BUNDLE_TIKTOK_ACCESS_TOKEN")
  const tiktokPixelCode = Netlify.env.get("BUNDLE_TIKTOK_PIXEL_CODE") // DC35EFRC77U1E073M9EG
  if (tiktokAccessToken && tiktokPixelCode) {
    await fireTikTokPurchaseEvent({
      pixelCode: tiktokPixelCode,
      accessToken: tiktokAccessToken,
      eventId: tagSessionId,
      email: customerDetails?.email,
      phone: customerDetails?.phone ?? undefined,
      value: purchaseValue,
      currency: orderCurrency,
      url: landingUrl,
      ip: clientIp,
      userAgent: clientUserAgent,
      contents: [
        {
          content_id: BUNDLE_PRODUCT_CONTENT_ID,
          content_type: "product",
          content_name: BUNDLE_PRODUCT_NAME,
          quantity: 1,
          price: unitAmount,
        },
      ],
    })
  } else {
    console.log("TikTok Events API not configured (missing BUNDLE_TIKTOK_ACCESS_TOKEN/BUNDLE_TIKTOK_PIXEL_CODE) - skipped")
  }

  const metaAccessToken = Netlify.env.get("BUNDLE_META_CAPI_ACCESS_TOKEN")
  const metaPixelId = Netlify.env.get("BUNDLE_META_PIXEL_ID") // 1166096572526475
  if (metaAccessToken && metaPixelId) {
    await fireMetaPurchaseEvent({
      pixelId: metaPixelId,
      accessToken: metaAccessToken,
      eventId: tagSessionId,
      email: customerDetails?.email,
      phone: customerDetails?.phone ?? undefined,
      value: purchaseValue,
      currency: orderCurrency,
      url: landingUrl,
      ip: clientIp,
      userAgent: clientUserAgent,
    })
  } else {
    console.log("Meta Conversions API not configured (missing BUNDLE_META_CAPI_ACCESS_TOKEN/BUNDLE_META_PIXEL_ID) - skipped")
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

async function fireTikTokPurchaseEvent(opts: {
  pixelCode: string
  accessToken: string
  eventId: string
  email?: string
  phone?: string
  value: number
  currency: string
  url: string
  ip?: string
  userAgent?: string
  contents?: Array<{
    content_id: string
    content_type: string
    content_name?: string
    quantity?: number
    price?: number
  }>
}) {
  const hash = (v?: string) =>
    v ? createHash("sha256").update(v.trim().toLowerCase()).digest("hex") : undefined

  const body = {
    event_source: "web",
    event_source_id: opts.pixelCode,
    data: [
      {
        event: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: opts.eventId,
        user: {
          email: hash(opts.email),
          phone: hash(opts.phone),
          ip: opts.ip,
          user_agent: opts.userAgent,
        },
        properties: {
          currency: opts.currency,
          value: opts.value,
          content_type: "product",
          content_id: opts.contents?.[0]?.content_id,
          contents: opts.contents,
        },
        page: { url: opts.url },
      },
    ],
  }

  try {
    const res = await fetch("https://business-api.tiktok.com/open_api/v1.3/event/track/", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Access-Token": opts.accessToken,
      },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (json.code !== 0) {
      console.error("Bundle TikTok Events API error:", JSON.stringify(json))
    } else {
      console.log("Bundle TikTok Purchase event sent:", opts.eventId)
    }
  } catch (err) {
    console.error("Bundle TikTok Events API call failed:", (err as Error).message)
  }
}

async function fireMetaPurchaseEvent(opts: {
  pixelId: string
  accessToken: string
  eventId: string
  email?: string
  phone?: string
  value: number
  currency: string
  url: string
  ip?: string
  userAgent?: string
}) {
  const hash = (v?: string) =>
    v ? createHash("sha256").update(v.trim().toLowerCase()).digest("hex") : undefined

  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: opts.eventId,
        action_source: "website",
        event_source_url: opts.url,
        user_data: {
          em: opts.email ? [hash(opts.email)] : undefined,
          ph: opts.phone ? [hash(opts.phone)] : undefined,
          client_ip_address: opts.ip,
          client_user_agent: opts.userAgent,
        },
        custom_data: {
          currency: opts.currency,
          value: opts.value,
        },
      },
    ],
  }

  try {
    const res = await fetch(
      `https://graph.facebook.com/v21.0/${opts.pixelId}/events?access_token=${opts.accessToken}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      },
    )
    const json = await res.json()
    if (json.error) {
      console.error("Bundle Meta Conversions API error:", JSON.stringify(json.error))
    } else {
      console.log("Bundle Meta Purchase event sent:", opts.eventId, JSON.stringify(json))
    }
  } catch (err) {
    console.error("Bundle Meta Conversions API call failed:", (err as Error).message)
  }
}

export const config: Config = {
  path: "/bundle-order-sync",
  method: ["POST"],
}
