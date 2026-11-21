// Cloudflare Pages Function: POST /stripe-order-sync
// Same job as the Netlify function this repo already runs for Pureglow Clearance
// (netlify/functions/stripe-order-sync.mts), ported to a Cloudflare Pages
// Function for the multi-product trendycatch.us site, plus one addition: it
// writes a short-lived "new order" notification into KV so the /admin.html
// dashboard can pick it up and play a sound, the way a Shopify POS does.
//
// Stripe payment -> Shopify order, straight away, no manual draft step.
// Creates a PAID, unfulfilled order directly on 3Doz.pet via the Admin GraphQL
// API, tagged "TrendyCatch" + "stripe-auto-sync", with the real customer name,
// email, phone and shipping address Stripe collected, and the product + chosen
// variant as the line item. Also fires server-side purchase events to TikTok,
// Meta (Facebook + Instagram share the same Pixel/CAPI) and Google (GA4
// Measurement Protocol, which covers Google Ads + YouTube via linked
// conversions) right after the Shopify order is created. Each platform call is
// independently optional (skipped with a log line if its env vars aren't set)
// and independently try/caught, so one platform failing can never block the
// Shopify order or any other platform.

interface Env {
  STRIPE_SECRET_KEY: string
  STRIPE_WEBHOOK_SECRET: string
  // Shopify sync is entirely optional — TrendyCatch runs standalone (its own
  // admin dashboard, its own KV order/revenue records) and does not require a
  // Shopify store. Only set these two if you deliberately want TrendyCatch
  // orders mirrored into a Shopify store as well.
  SHOPIFY_STORE_DOMAIN?: string
  SHOPIFY_ADMIN_TOKEN?: string
  ORDER_EMAIL?: string
  SITE_URL?: string
  TIKTOK_ACCESS_TOKEN?: string
  TIKTOK_PIXEL_CODE?: string
  META_CAPI_ACCESS_TOKEN?: string
  META_PIXEL_ID?: string
  GA4_MEASUREMENT_ID?: string
  GA4_API_SECRET?: string
  // KV namespace binding (see wrangler.toml) used only for the admin sound
  // notification feed; never required for the order to sync to Shopify.
  ORDERS_KV?: KVNamespace
  ORDERS_DB?: D1Database
}

const SHOPIFY_API_VERSION = "2025-01"

const COUNTRY_NAMES: Record<string, string> = {
  AU: "Australia",
  NZ: "New Zealand",
  US: "United States",
  CA: "Canada",
  GB: "United Kingdom",
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.STRIPE_SECRET_KEY || !env.STRIPE_WEBHOOK_SECRET) {
    console.error("Missing required environment variable(s)")
    return new Response("Server misconfigured", { status: 500 })
  }
  const shopifyConfigured = Boolean(env.SHOPIFY_STORE_DOMAIN && env.SHOPIFY_ADMIN_TOKEN)

  const signature = request.headers.get("stripe-signature")
  const rawBody = await request.text()

  let event: any
  try {
    if (!signature) throw new Error("Missing stripe-signature header")
    // Trim in case the secret was pasted into Cloudflare with a trailing
    // newline/space — that invisible difference otherwise makes every
    // signature check fail with no obvious cause.
    event = await verifyStripeSignature(rawBody, signature, env.STRIPE_WEBHOOK_SECRET.trim())
  } catch (err) {
    console.error("Stripe signature verification failed:", (err as Error).message)
    return new Response("Invalid signature", { status: 400 })
  }

  if (event.type !== "checkout.session.completed") {
    return new Response("ignored", { status: 200 })
  }

  const sessionSummary = event.data.object
  if (sessionSummary.payment_status !== "paid") {
    return new Response("not paid yet", { status: 200 })
  }

  // Re-fetch with line items + product metadata expanded; the webhook payload
  // alone doesn't include them.
  const session = await stripeGet(
    env,
    `/v1/checkout/sessions/${sessionSummary.id}`,
    "expand[]=line_items.data.price.product&expand[]=customer_details",
  )

  // Durable history is written before the alert feed and Shopify sync. A batch
  // and unique Stripe IDs make retrying an event safe for these records.
  if (env.ORDERS_DB) {
    try { await recordOrderHistory(env.ORDERS_DB, session) }
    catch (error) { console.error('Order history write failed', (error as Error).message); return new Response('Order storage unavailable', { status: 503 }) }
  }

  const sessionIdHash = await sha256Hex(session.id)
  const tagSessionId = `stripe-${sessionIdHash.slice(0, 16)}`

  // Which ad platform this order came from — set by the browser in
  // create-checkout.ts's "source" field (derived from UTM params / each
  // network's own click-id param) and carried on the Stripe session's
  // metadata, so it's visible on both the Shopify order and the admin feed.
  const rawSource = (session.metadata?.source ?? "direct") as string
  const sourceLabel = labelForSource(rawSource)
  const orderTags = ["TrendyCatch", "stripe-auto-sync", tagSessionId, `source-${rawSource.toLowerCase()}`]

// Dedup key, independent of Shopify: Stripe retries the same webhook event
  // on any non-2xx response, so without this a retry would double-count the
  // order in KV stats/admin feed even with Shopify sync turned off.
  const dedupeKey = `synced:${tagSessionId}`
  if (env.ORDERS_KV) {
    try {
      const already = await env.ORDERS_KV.get(dedupeKey)
      if (already) {
        console.log(`Order already processed for ${session.id}, skipping duplicate webhook delivery`)
        return new Response("duplicate, skipped", { status: 200 })
      }
    } catch (err) {
      console.error("KV dedupe check failed, proceeding anyway:", (err as Error).message)
    }
  }

  if (shopifyConfigured) {
    try {
      const already = await shopifyGraphql(
        env.SHOPIFY_STORE_DOMAIN!,
        env.SHOPIFY_ADMIN_TOKEN!,
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

  const lineItems = (session.line_items?.data ?? []).map((li: any) => {
    const unitAmount = (li.price?.unit_amount ?? 0) / 100
    const product = li.price?.product
    const productTitle = typeof product === "object" && product?.name ? product.name : li.description ?? "Item"
    const variant = typeof product === "object" ? product?.metadata?.variant : undefined
    return {
      title: variant ? `${productTitle} — ${variant}` : productTitle,
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

  const orderCurrency = (session.currency ?? "aud").toUpperCase()
  const orderEmail = env.ORDER_EMAIL ?? "orders@trendycatch.us"

  let createdOrder: { id?: string; name?: string } | undefined

  if (shopifyConfigured) {
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
      note: `Auto-synced from Stripe checkout ${session.id}. Customer email: ${customerDetails?.email ?? "unknown"}. Source: ${sourceLabel}${session.metadata?.landing_url ? ` (${session.metadata.landing_url})` : ""}`,
      sourceName: "stripe",
      processedAt: new Date((session.created ?? Date.now() / 1000) * 1000).toISOString(),
    }

    const mutation = `mutation OrderCreate($order: OrderCreateOrderInput!, $options: OrderCreateOptionsInput) {
      orderCreate(order: $order, options: $options) {
        order { id name }
        userErrors { field message }
      }
    }`

    const result = await shopifyGraphql(env.SHOPIFY_STORE_DOMAIN!, env.SHOPIFY_ADMIN_TOKEN!, mutation, {
      order: orderInput,
      options: { sendReceipt: false, sendFulfillmentReceipt: false },
    })

    const userErrors = result?.data?.orderCreate?.userErrors ?? []
    if (userErrors.length > 0) {
      console.error("Shopify orderCreate userErrors:", JSON.stringify(userErrors))
      return new Response(`Shopify rejected the order: ${JSON.stringify(userErrors)}`, { status: 502 })
    }

    createdOrder = result?.data?.orderCreate?.order
    console.log(`Created Shopify order ${createdOrder?.name} for Stripe session ${session.id}`)

    if (createdOrder?.id) {
      try {
        const tagResult = await shopifyGraphql(
          env.SHOPIFY_STORE_DOMAIN!,
          env.SHOPIFY_ADMIN_TOKEN!,
          `mutation AddOrderTags($id: ID!, $tags: [String!]!) {
            tagsAdd(id: $id, tags: $tags) { userErrors { field message } }
          }`,
          { id: createdOrder.id, tags: orderTags },
        )
        const tagErrors = tagResult?.data?.tagsAdd?.userErrors ?? []
        if (tagErrors.length > 0) console.error("tagsAdd userErrors:", JSON.stringify(tagErrors))
      } catch (err) {
        console.error("tagsAdd failed (order was still created):", (err as Error).message)
      }
    }
  } else {
    console.log("Shopify sync not configured — order recorded in TrendyCatch's own dashboard only")
  }

  // ---- Admin dashboard "new order" sound notification (best-effort, KV) ----
  const orderTotal = (session.amount_total ?? 0) / 100
  if (env.ORDERS_KV) {
    try {
      const notification = {
        id: tagSessionId,
        orderName: createdOrder?.name ?? "New order",
        customerName: fullName,
        email: customerDetails?.email ?? null,
        phone: customerDetails?.phone ?? null,
        country: addr?.country ?? null,
        total: orderTotal,
        currency: orderCurrency,
        items: lineItems.map((li: any) => ({ title: li.title, quantity: li.quantity })),
        source: rawSource,
        sourceLabel,
        landingUrl: session.metadata?.landing_url ?? null,
        createdAt: new Date().toISOString(),
      }
      // Key sortable by time, auto-expires after 2 days so the feed never grows unbounded.
      await env.ORDERS_KV.put(`order:${Date.now()}:${tagSessionId}`, JSON.stringify(notification), {
        expirationTtl: 60 * 60 * 48,
      })
    } catch (err) {
      console.error("Order notification KV write failed (order was still created):", (err as Error).message)
    }

    // ---- Running revenue/orders totals (never expire) for the dashboard's
    // "home screen" summary — total revenue, revenue by country, orders by
    // ad platform — the same kind of numbers Shopify's own Home shows.
    try {
      await updateStatsSummary(env.ORDERS_KV, {
        country: addr?.country ?? "UNKNOWN",
        source: rawSource.toLowerCase(),
        total: orderTotal,
      })
    } catch (err) {
      console.error("Stats summary update failed (order was still created):", (err as Error).message)
    }
  }

  // ---- Ad-platform purchase tracking (additive, non-blocking) ----
  const purchaseValue = (session.amount_total ?? 0) / 100
  const landingUrl = env.SITE_URL ?? "https://trendycatch.us"
  const clientIp = request.headers.get("x-forwarded-for") ?? undefined
  const clientUserAgent = request.headers.get("user-agent") ?? undefined

  const tiktokContents = (session.line_items?.data ?? []).map((li: any) => {
    const product = li.price?.product
    const productId = typeof product === "object" ? product?.metadata?.product_id : undefined
    const productName = typeof product === "object" && product?.name ? product.name : li.description ?? "Item"
    return {
      content_id: productId ?? "unknown",
      content_type: "product",
      content_name: productName,
      quantity: li.quantity ?? 1,
      price: (li.price?.unit_amount ?? 0) / 100,
    }
  })

  if (env.TIKTOK_ACCESS_TOKEN && env.TIKTOK_PIXEL_CODE) {
    await fireTikTokPurchaseEvent({
      pixelCode: env.TIKTOK_PIXEL_CODE,
      accessToken: env.TIKTOK_ACCESS_TOKEN,
      eventId: tagSessionId,
      email: customerDetails?.email,
      phone: customerDetails?.phone ?? undefined,
      value: purchaseValue,
      currency: orderCurrency,
      url: landingUrl,
      ip: clientIp,
      userAgent: clientUserAgent,
      contents: tiktokContents,
    })
  } else {
    console.log("TikTok Events API not configured — skipped")
  }

  if (env.META_CAPI_ACCESS_TOKEN && env.META_PIXEL_ID) {
    await fireMetaPurchaseEvent({
      pixelId: env.META_PIXEL_ID,
      accessToken: env.META_CAPI_ACCESS_TOKEN,
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
    console.log("Meta Conversions API not configured — skipped")
  }

  if (env.GA4_MEASUREMENT_ID && env.GA4_API_SECRET) {
    await fireGa4PurchaseEvent({
      measurementId: env.GA4_MEASUREMENT_ID,
      apiSecret: env.GA4_API_SECRET,
      clientId: tagSessionId,
      transactionId: tagSessionId,
      value: purchaseValue,
      currency: orderCurrency,
      itemName: lineItems[0]?.title ?? "TrendyCatch order",
    })
  } else {
    console.log("GA4 Measurement Protocol not configured — skipped")
  }

  if (env.ORDERS_KV) {
    try {
      // 48h is plenty — Stripe stops retrying a webhook well before that.
      await env.ORDERS_KV.put(dedupeKey, "1", { expirationTtl: 60 * 60 * 48 })
    } catch (err) {
      console.error("Dedupe marker write failed (order was still processed):", (err as Error).message)
    }
  }

  return new Response(JSON.stringify({ ok: true, order: createdOrder }), {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

async function recordOrderHistory(db: D1Database, session: any): Promise<void> {
  if (typeof session.id !== 'string' || !Array.isArray(session.line_items?.data)) throw new Error('Incomplete checkout session')
  const customer = session.customer_details ?? {}
  const shipping = session.collected_information?.shipping_details ?? session.shipping_details ?? null
  const created = new Date((session.created ?? Date.now() / 1000) * 1000).toISOString()
  const now = new Date().toISOString()
  const stmts = [db.prepare(`INSERT OR IGNORE INTO orders (id, stripe_session_id, created_at, customer_name, customer_email, customer_phone, shipping_name, shipping_address_json, billing_address_json, currency, total_minor, payment_status, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(
    session.id, session.id, created, customer.name ?? null, customer.email ?? null, customer.phone ?? null,
    shipping?.name ?? null, shipping?.address ? JSON.stringify(shipping.address) : null,
    customer.address ? JSON.stringify(customer.address) : null, String(session.currency ?? '').toUpperCase(),
    session.amount_total ?? 0, session.payment_status, now,
  )]
  for (const item of session.line_items.data) {
    if (typeof item.id !== 'string') throw new Error('Missing Stripe line item ID')
    const product = typeof item.price?.product === 'object' ? item.price.product : null
    stmts.push(db.prepare(`INSERT OR IGNORE INTO order_items (order_id, stripe_line_id, product_id, title, variant, quantity, unit_amount_minor) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(
      session.id, item.id, product?.metadata?.product_id ?? session.metadata?.product_id ?? null,
      product?.name ?? item.description ?? 'Item', product?.metadata?.variant ?? session.metadata?.variant ?? null,
      item.quantity ?? 1, item.price?.unit_amount ?? null,
    ))
  }
  await db.batch(stmts)
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Turns the short source code the landing page detected (see index.html's
// detectSource()) into the clear, human-readable label shown on the order
// note and the admin dashboard — so the report always says plainly which
// platform an order came from, not just a tag slug.
function labelForSource(code: string): string {
  const labels: Record<string, string> = {
    facebook: "Facebook (Meta Ads)",
    instagram: "Instagram (Meta Ads)",
    meta: "Facebook/Instagram (Meta Ads)",
    tiktok: "TikTok Ads",
    google: "Google Ads",
    youtube: "YouTube (Google Ads)",
    bing: "Microsoft/Bing Ads",
    pinterest: "Pinterest Ads",
    snapchat: "Snapchat Ads",
    organic_search: "Organic search",
    direct: "Direct / typed URL",
    referral: "Referral link",
  }
  return labels[code.toLowerCase()] ?? `Other (${code})`
}

// Keeps one small, permanent JSON summary in KV — total revenue/orders, plus
// broken down by country and by ad-platform source — so the admin dashboard
// can show a Shopify-Home-style "how's business doing" snapshot instead of
// only the rolling 48h new-order feed. Read-modify-write against a single
// key; fine at this order volume (a lost increment under a rare simultaneous
// webhook pair just means the next poll is one order behind, never wrong for
// long).
async function updateStatsSummary(
  kv: KVNamespace,
  order: { country: string; source: string; total: number },
): Promise<void> {
  const key = "stats:summary"
  const raw = await kv.get(key)
  const stats = raw
    ? JSON.parse(raw)
    : { totalRevenue: 0, totalOrders: 0, byCountry: {} as Record<string, { revenue: number; orders: number }>, bySource: {} as Record<string, { revenue: number; orders: number }> }

  stats.totalRevenue = (stats.totalRevenue ?? 0) + order.total
  stats.totalOrders = (stats.totalOrders ?? 0) + 1

  const country = order.country || "UNKNOWN"
  stats.byCountry[country] = stats.byCountry[country] ?? { revenue: 0, orders: 0 }
  stats.byCountry[country].revenue += order.total
  stats.byCountry[country].orders += 1

  const source = order.source || "direct"
  stats.bySource[source] = stats.bySource[source] ?? { revenue: 0, orders: 0 }
  stats.bySource[source].revenue += order.total
  stats.bySource[source].orders += 1

  stats.updatedAt = new Date().toISOString()

  await kv.put(key, JSON.stringify(stats))
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

// Verifies a Stripe webhook signature using Web Crypto (HMAC-SHA256), since the
// Stripe Node SDK's webhooks.constructEvent relies on Node's `crypto` module,
// which isn't available the same way in the Workers runtime unless
// nodejs_compat is on. This avoids that dependency entirely.
async function verifyStripeSignature(payload: string, sigHeader: string, secret: string): Promise<any> {
  const parts = Object.fromEntries(sigHeader.split(",").map((p) => p.split("=")) as [string, string][])
  const timestamp = parts["t"]
  const signature = parts["v1"]
  if (!timestamp || !signature) throw new Error("Malformed stripe-signature header")

  const signedPayload = `${timestamp}.${payload}`
  const key = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const mac = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(signedPayload))
  const expected = [...new Uint8Array(mac)].map((b) => b.toString(16).padStart(2, "0")).join("")

  if (expected !== signature) throw new Error("Signature mismatch")

  // 5 minute tolerance, same default Stripe's own SDK uses.
  const age = Math.abs(Date.now() / 1000 - Number(timestamp))
  if (age > 300) throw new Error("Timestamp outside tolerance")

  return JSON.parse(payload)
}

async function stripeGet(env: Env, path: string, query: string) {
  const res = await fetch(`https://api.stripe.com${path}?${query}`, {
    headers: { Authorization: `Bearer ${env.STRIPE_SECRET_KEY}` },
  })
  if (!res.ok) throw new Error(`Stripe GET ${path} failed: ${res.status} ${await res.text()}`)
  return res.json()
}

async function shopifyGraphql(shopDomain: string, token: string, query: string, variables: Record<string, unknown>) {
  const res = await fetch(`https://${shopDomain}/admin/api/${SHOPIFY_API_VERSION}/graphql.json`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Shopify-Access-Token": token },
    body: JSON.stringify({ query, variables }),
  })
  if (!res.ok) throw new Error(`Shopify API error ${res.status}: ${await res.text()}`)
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
  contents?: Array<{ content_id: string; content_type: string; content_name?: string; quantity?: number; price?: number }>
}) {
  const hash = async (v?: string) => (v ? await sha256Hex(v.trim().toLowerCase()) : undefined)
  const body = {
    event_source: "web",
    event_source_id: opts.pixelCode,
    data: [
      {
        event: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: opts.eventId,
        user: { email: await hash(opts.email), phone: await hash(opts.phone), ip: opts.ip, user_agent: opts.userAgent },
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
      headers: { "Content-Type": "application/json", "Access-Token": opts.accessToken },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (json.code !== 0) console.error("TikTok Events API error:", JSON.stringify(json))
    else console.log("TikTok Purchase event sent:", opts.eventId)
  } catch (err) {
    console.error("TikTok Events API call failed:", (err as Error).message)
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
  const hash = async (v?: string) => (v ? await sha256Hex(v.trim().toLowerCase()) : undefined)
  const body = {
    data: [
      {
        event_name: "Purchase",
        event_time: Math.floor(Date.now() / 1000),
        event_id: opts.eventId,
        action_source: "website",
        event_source_url: opts.url,
        user_data: {
          em: opts.email ? [await hash(opts.email)] : undefined,
          ph: opts.phone ? [await hash(opts.phone)] : undefined,
          client_ip_address: opts.ip,
          client_user_agent: opts.userAgent,
        },
        custom_data: { currency: opts.currency, value: opts.value },
      },
    ],
  }
  try {
    const res = await fetch(`https://graph.facebook.com/v21.0/${opts.pixelId}/events?access_token=${opts.accessToken}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const json = await res.json()
    if (json.error) console.error("Meta Conversions API error:", JSON.stringify(json.error))
    else console.log("Meta Purchase event sent:", opts.eventId)
  } catch (err) {
    console.error("Meta Conversions API call failed:", (err as Error).message)
  }
}

async function fireGa4PurchaseEvent(opts: {
  measurementId: string
  apiSecret: string
  clientId: string
  transactionId: string
  value: number
  currency: string
  itemName: string
}) {
  const body = {
    client_id: opts.clientId,
    events: [
      {
        name: "purchase",
        params: {
          transaction_id: opts.transactionId,
          currency: opts.currency,
          value: opts.value,
          items: [{ item_name: opts.itemName, quantity: 1, price: opts.value }],
        },
      },
    ],
  }
  try {
    const res = await fetch(
      `https://www.google-analytics.com/mp/collect?measurement_id=${opts.measurementId}&api_secret=${opts.apiSecret}`,
      { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) },
    )
    if (!res.ok) console.error("GA4 Measurement Protocol error:", res.status, await res.text())
    else console.log("GA4 purchase event sent:", opts.transactionId)
  } catch (err) {
    console.error("GA4 Measurement Protocol call failed:", (err as Error).message)
  }
}
