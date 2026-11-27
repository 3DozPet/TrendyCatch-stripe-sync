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

  // Secrets pasted into the Cloudflare dashboard sometimes pick up a trailing
  // newline or space from the copy — that's an invisible difference that
  // otherwise throws an uncaught "invalid header value" error and crashes the
  // whole function (a raw Cloudflare 502, not our own JSON error below).
  const stripeSecretKey = (env.STRIPE_SECRET_KEY || "").trim()
  if (!stripeSecretKey) {
    return json({ error: "Server misconfigured: missing STRIPE_SECRET_KEY" }, 500)
  }

  let body: { productId?: string; variantSku?: string; country?: string; source?: string; landingUrl?: string }
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
    variants?: Array<{ label: string; sku: string; prices?: Record<CountryCode, number> }>
    image?: string
    images?: string[]
    prices: Record<CountryCode, number>
    shipsTo?: CountryCode[]
  }> = await productsRes.json()

  const product = products.find((p) => p.id === productId)
  if (!product) {
    return json({ error: "Unknown product" }, 404)
  }

  // Some products can't be delivered everywhere (e.g. not to NZ). Such a
  // product lists the countries it ships to; checkout is refused elsewhere,
  // and Stripe only accepts a shipping address in one of those countries.
  const shipTo = product.shipsTo && product.shipsTo.length ? product.shipsTo : SHIP_TO_COUNTRIES
  if (!shipTo.includes(country)) {
    return json({ error: "This product isn't available for delivery to your country" }, 400)
  }

  // If this product has real selectable options, the chosen one must be one
  // of the catalog's own skus — never trust an arbitrary string from the
  // browser. Falls back to the product's single descriptive variant text
  // when it has no selectable options (or none/an invalid one was sent).
  const availableVariants = product.variants ?? []
  const matchedVariant = availableVariants.find((v) => v.sku === body.variantSku)
  const variantLabel = matchedVariant ? matchedVariant.label : product.variant

  // A variant like a bigger pack or bag size can cost more than the base
  // product price. The charged amount always comes from this catalog file,
  // computed from the matched variant — never from a price the browser
  // sends — so it can't be tampered with and stays correct if the variant
  // carries its own price for this country; otherwise it falls back to the
  // product's flat price, same as before per-variant pricing existed.
  const unitPrice = matchedVariant?.prices?.[country] ?? product.prices[country]
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
  shipTo.forEach((c, i) => params.append(`shipping_address_collection[allowed_countries][${i}]`, c))
  params.set("line_items[0][quantity]", "1")
  params.set("line_items[0][price_data][currency]", currency)
  params.set("line_items[0][price_data][unit_amount]", String(Math.round(unitPrice * 100)))
  params.set("line_items[0][price_data][product_data][name]", product.title)
  params.set("line_items[0][price_data][product_data][description]", variantLabel)
  params.set("line_items[0][price_data][product_data][metadata][product_id]", product.id)
  params.set("line_items[0][price_data][product_data][metadata][variant]", variantLabel)
  params.set("metadata[product_id]", product.id)
  params.set("metadata[variant]", variantLabel)
  params.set("metadata[country]", country)
  params.set("metadata[source]", source)
  if (landingUrl) params.set("metadata[landing_url]", landingUrl)

  // Wrapped in try/catch so a bad key, network hiccup, or malformed header
  // never crashes the function with a raw Cloudflare 502 — the client always
  // gets back a readable JSON error instead.
  let stripeRes: Response
  try {
    stripeRes = await fetch("https://api.stripe.com/v1/checkout/sessions", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${stripeSecretKey}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: params.toString(),
    })
  } catch (err) {
    console.error("Stripe request failed:", err instanceof Error ? err.message : err)
    return json({ error: "Could not reach Stripe" }, 502)
  }

  let session: any
  try {
    session = await stripeRes.json()
  } catch {
    return json({ error: "Stripe returned an unreadable response" }, 502)
  }

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
