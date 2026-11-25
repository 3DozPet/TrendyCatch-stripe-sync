// Shared Stripe <-> D1 order-history helpers. Lives under _lib/ (not as a
// route file) so it can be imported by both stripe-order-sync.ts (the
// webhook, one session at a time) and admin-backfill-stripe.ts (the
// on-demand backfill, many sessions at once) without one route file
// importing another — see admin-gate.ts's comment for why that breaks at
// Cloudflare's publish step even though it typechecks fine locally.

// Writes one Stripe Checkout Session (with line_items + customer_details
// expanded) into the orders/order_items tables. INSERT OR IGNORE on both
// tables' unique keys (orders.id / order_items.stripe_line_id) makes this
// safe to call repeatedly for the same session — the webhook calls it once
// per live purchase, and the backfill endpoint calls it again for every
// historical session on every run, with no risk of duplicating rows.
export async function recordOrderHistory(db: D1Database, session: any): Promise<void> {
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
    // Stripe's expanded Product object carries an `images` array (set when the
    // product was created/updated in Stripe) — take the first one, if any, as
    // the small thumbnail shown next to this line item in the admin dashboard.
    const imageUrl = Array.isArray(product?.images) && typeof product.images[0] === 'string' ? product.images[0] : null
    stmts.push(db.prepare(`INSERT OR IGNORE INTO order_items (order_id, stripe_line_id, product_id, title, variant, quantity, unit_amount_minor, image_url) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).bind(
      session.id, item.id, product?.metadata?.product_id ?? session.metadata?.product_id ?? null,
      product?.name ?? item.description ?? 'Item', product?.metadata?.variant ?? session.metadata?.variant ?? null,
      item.quantity ?? 1, item.price?.unit_amount ?? null, imageUrl,
    ))
    // INSERT OR IGNORE above leaves an already-written row untouched, so a
    // line item synced before this column existed (or before its product had
    // an image) would otherwise never pick one up. Backfill it in place —
    // only when the row still has no image — on every call, including a
    // repeat "Sync from Stripe" click or the next live webhook delivery.
    if (imageUrl) {
      stmts.push(db.prepare(`UPDATE order_items SET image_url = ? WHERE stripe_line_id = ? AND image_url IS NULL`).bind(imageUrl, item.id))
    }
  }
  await db.batch(stmts)
}

// Lists every PAID Checkout Session's ID from Stripe. Deliberately does NOT
// try to expand line_items here: Stripe's own docs warn that deep nested
// expansions (line_items -> its line items -> each one's price -> its
// product, four levels across two list boundaries) are unreliable on LIST
// endpoints specifically ("try to limit many nested expansions on list
// requests" — https://docs.stripe.com/expand) — in practice it silently
// comes back empty rather than erroring, which made every session fail
// recordOrderHistory's "Incomplete checkout session" check with no visible
// error. Fetching full details per-session (fetchFullCheckoutSession below)
// uses the exact same expand already proven to work by the live webhook in
// stripe-order-sync.ts, which only ever expands a single retrieved session.
// Paginated via starting_after; capped at maxSessions as a safety valve so a
// misbehaving account (or an infinite has_more loop) can't run away — in
// practice this store has nowhere near that many orders.
export async function listPaidCheckoutSessionIds(
  secretKey: string,
  maxSessions = 2000,
): Promise<{ ids: string[]; truncated: boolean }> {
  const out: string[] = []
  let startingAfter: string | undefined
  let truncated = false
  for (let page = 0; page < 50; page++) {
    const params = new URLSearchParams({ limit: '100', status: 'complete' })
    if (startingAfter) params.set('starting_after', startingAfter)
    const res = await fetch(`https://api.stripe.com/v1/checkout/sessions?${params.toString()}`, {
      headers: { Authorization: `Bearer ${secretKey}` },
    })
    if (!res.ok) throw new Error(`Stripe request failed (${res.status})`)
    const json: any = await res.json()
    const data: any[] = json.data || []
    out.push(...data.filter((s) => s.livemode === true && s.payment_status === 'paid').map((s) => s.id))
    if (out.length >= maxSessions) { truncated = Boolean(json.has_more); break }
    if (!json.has_more || data.length === 0) break
    startingAfter = data[data.length - 1].id
  }
  return { ids: out, truncated }
}

// Fetches ONE Checkout Session with line_items + customer_details expanded —
// the same shape, from the same kind of request, that stripe-order-sync.ts's
// webhook already fetches successfully for every live order.
export async function fetchFullCheckoutSession(secretKey: string, sessionId: string): Promise<any> {
  const params = new URLSearchParams()
  params.append('expand[]', 'line_items.data.price.product')
  params.append('expand[]', 'customer_details')
  const res = await fetch(`https://api.stripe.com/v1/checkout/sessions/${sessionId}?${params.toString()}`, {
    headers: { Authorization: `Bearer ${secretKey}` },
  })
  if (!res.ok) throw new Error(`Stripe request failed (${res.status})`)
  return res.json()
}

// Combines the two above: lists every paid session ID, then fetches each
// one's full details with limited concurrency (kind to Stripe's rate limits
// and to the Worker's own request budget) so recordOrderHistory gets a
// complete session object for every order, not just the ones on the first
// list page.
export async function fetchAllPaidCheckoutSessions(
  secretKey: string,
  maxSessions = 2000,
  concurrency = 5,
): Promise<{ sessions: any[]; truncated: boolean; fetchFailures: string[] }> {
  const { ids, truncated } = await listPaidCheckoutSessionIds(secretKey, maxSessions)
  const sessions: any[] = []
  const fetchFailures: string[] = []
  let cursor = 0
  async function worker() {
    while (cursor < ids.length) {
      const id = ids[cursor++]
      try {
        const session = await fetchFullCheckoutSession(secretKey, id)
        if (session.livemode === true && session.payment_status === 'paid') sessions.push(session)
      } catch (error) {
        fetchFailures.push(`${id}: ${(error as Error).message}`)
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, ids.length) }, worker))
  return { sessions, truncated, fetchFailures }
}
// Stripe signs the timestamp and unmodified request body for each delivery.
export async function verifyStripeSignature(payload: string, header: string, secret: string): Promise<any> {
  const signatures = header.split(',').map(part => part.trim().split('=', 2))
  const timestamp = signatures.find(([version]) => version === 't')?.[1]
  if (!timestamp || !/^\d+$/.test(timestamp) || Math.abs(Date.now() / 1000 - Number(timestamp)) > 300) {
    throw new Error('Invalid Stripe signature timestamp')
  }

  const encoder = new TextEncoder()
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['verify'])
  const signedPayload = encoder.encode(`${timestamp}.${payload}`)
  for (const [version, signature] of signatures) {
    if (version !== 'v1' || !/^[a-f0-9]{64}$/.test(signature ?? '')) continue
    const bytes = Uint8Array.from(signature.match(/../g)!, pair => parseInt(pair, 16))
    if (await crypto.subtle.verify('HMAC', key, bytes, signedPayload)) return JSON.parse(payload)
  }
  throw new Error('Invalid Stripe signature')
}
