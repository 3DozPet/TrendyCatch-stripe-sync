// Cloudflare Pages Function: POST /create-checkout
// Builds a Stripe Checkout Session for one product in one currency, server-side,
// from the authoritative products.json (never trusts a price the browser sends).
// Collects full name, email, phone and shipping address on Stripe's own page,
// and records the chosen variant so it shows up on the synced Shopify order.

interface Env {
  STRIPE_SECRET_KEY: string
  SITE_URL?: string
}

type CountryCode = "AU" | "NZ" | "US" | "CA"

const CURRENCY_BY_COUNTRY: Record<CountryCode, string> = {
  AU: "aud",
  NZ: "nzd",
  US: "usd",
  CA: "cad",
}

const SHIP_TO_COUNTRIES: CountryCode[] = ["AU", "NZ", "US", "CA"]

export const onRequestPost: PagesFunction<Env> = async (context) => {
  const { request, env } = context

  if (!env.STRIPE_SECRET_KEY) {
    return json({ error: "Server misconfigured: missing STRIPE_SECRET_KEY" }, 500)
  }

  let body: { productId?: string; country?: string; source?: string; landingUrl?: string }
  try {
    body = await request.json()
  } catch {
    return json({ error: "Invalid JSON body" }, 400)
  }

  const productId = body.productId
  const country = (body.country || "").toUpperCase() as CountryCode
  if (!productId || !SHIP_TO_COUNTRIES.includes(country)) {
    return json({ error: "Missing or invalid productId/country" }, 400)
  }

  // Attribution: which ad platform this visitor arrived from, worked out in
  // the browser from the landing page's own URL (UTM params + the
  // platform-specific click-id params each ad network appends) and passed
  // through here so it survives all the way to the Shopify order + admin feed.
  const source = (body.source || "direct").slice(0, 100)
  const landingUrl = (body.landingUrl || "").slice(0, 500)

  const origin = new URL(request.url).origin
  const siteUrl = (env.SITE_URL || origin).replace(/\/$/, "")

  // Load the authoritative product + price list from this same deployment's
  // static assets, so the price charged always matches what's on products.json
  // — a client could otherwise tamper with the amount in the request body.
  const productsRes = await fetch(`${origin}/products.json`)
  if (!productsRes.ok) {
    return json({ error: "Could not load product catalog" }, 500)
  }
  const products: Array<{
    id: string
    title: string
    variant: string
    image: string
    prices: Record<CountryCode, number>
  }> = await productsRes.json()

  const product = products.find((p) => p.id === productId)
  if (!product) {
    return json({ error: "Unknown product" }, 404)
  }
  const unitPrice = product.prices[country]
  if (typeof unitPrice !== "number") {
    return json({ error: "No price configured for this country" }, 400)
  }

  const currency = CURRENCY_BY_COUNTRY[country]

  const params = new URLSearchParams()
  params.set("mode", "payment")
  params.set("success_url", `${siteUrl}/thank-you.html?session_id={CHECKOUT_SESSION_ID}`)
  params.set("cancel_url", `${siteUrl}/?cancelled=1`)
  params.set("phone_number_collection[enabled]", "true")
  params.set("billing_address_collection", "required")
  SHIP_TO_COUNTRIES.forEach((c, i) => params.append(`shipping_address_collection[allowed_countries][${i}]`, c))
  params.set("line_items[0][quantity]", "1")
  params.set("line_items[0][price_data][currency]", currency)
  params.set("line_items[0][price_data][unit_amount]", String(Math.round(unitPrice * 100)))
  params.set("line_items[0][price_data][product_data][name]", product.title)
  params.set("line_items[0][price_data][product_data][description]", product.variant)
  params.set("line_items[0][price_data][product_data][metadata][product_id]", product.id)
  params.set("line_items[0][price_data][product_data][metadata][variant]", product.variant)
  params.set("metadata[product_id]", product.id)
  params.set("metadata[variant]", product.variant)
  params.set("metadata[country]", country)
  params.set("metadata[source]", source)
  if (landingUrl) params.set("metadata[landing_url]", landingUrl)

  const stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${env.STRIPE_SECRET_KEY}`,
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: params.toString(),
  })

  const session = await stripeRes.json()
  if (!stripeRes.ok) {
    console.error("Stripe session create failed:", JSON.stringify(session))
    return json({ error: session?.error?.message ?? "Stripe error" }, 502)
  }

  return json({ url: session.url })
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  })
}
