// POST /subscribe — the storefront's "get 10% off" email capture. Public and
// anonymous (anyone browsing can sign up), but what it stores is NOT public:
// the signup list is only ever read back through /admin-subscribers, which is
// gated the same way as the rest of the dashboard (hasValidSession).
// Dedupes by email so submitting twice just refreshes the record instead of
// creating duplicates.
//
// Welcome coupon: the first signup for an email address is issued one
// single-use code (10% off the first 30.00 of an order, so at most 3.00 off,
// in the shopper's own currency) and it is emailed straight away via Resend.
// An address that already has a code never gets a second one. The code is
// redeemed in /create-checkout, which owns the discount maths.

interface Env {
  ORDERS_KV?: KVNamespace
  RESEND_API_KEY?: string
}

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "Server not configured." }, 500)

  let body: { email?: string; source?: string; landingUrl?: string } = {}
  try {
    body = await request.json()
  } catch {
    // ignore, validated below
  }

  const email = (body.email || "").trim().toLowerCase()
  if (!isLikelyEmail(email)) {
    return json({ error: "Please enter a valid email address." }, 400)
  }

  const country = (request as any).cf?.country ?? "UNKNOWN"
  const key = `subscriber:${await sha256Hex(email)}`

  const existingRaw = await env.ORDERS_KV.get(key)
  const existing = existingRaw ? JSON.parse(existingRaw) : null
  const createdAt = existing ? existing.createdAt : new Date().toISOString()

  // One code per email address, ever: reuse the one already on file.
  const alreadyHadCode = Boolean(existing && existing.couponCode)
  const couponCode: string = alreadyHadCode ? existing.couponCode : newCouponCode()

  const record = {
    email,
    country,
    source: (body.source || "direct").toString().slice(0, 100),
    landingUrl: (body.landingUrl || "").toString().slice(0, 500),
    createdAt,
    updatedAt: new Date().toISOString(),
    couponCode,
    couponEmailedAt: existing?.couponEmailedAt ?? null,
    unsubscribed: Boolean(existing?.unsubscribed),
  }

  if (!alreadyHadCode) {
    await env.ORDERS_KV.put(`coupon:${couponCode}`, JSON.stringify({ subscriberKey: key, status: "unused", createdAt: record.updatedAt }))
  }

  // One email, one coupon, sent once — full stop. Signing up again with the
  // same address never generates a new code and never re-triggers the
  // email, whether the code has been used or is still sitting unused. The
  // only exception: if the very first send never actually went out
  // (couponEmailedAt is still null — Resend wasn't configured yet, or the
  // provider rejected it), that one real attempt still hasn't happened, so
  // it's retried here rather than leaving the signup silently coupon-less.
  let couponStatus = "unused"
  if (alreadyHadCode) {
    const couponRaw = await env.ORDERS_KV.get(`coupon:${couponCode}`)
    if (couponRaw) {
      try {
        couponStatus = JSON.parse(couponRaw).status || "unused"
      } catch {
        couponStatus = "unused"
      }
    }
  }

  const alreadyUsed = alreadyHadCode && couponStatus === "used"
  const neverSuccessfullyEmailed = !record.couponEmailedAt
  const eligibleToSend = !record.unsubscribed && !alreadyUsed && (!alreadyHadCode || neverSuccessfullyEmailed)

  // emailStatus says why an email did or didn't go (no secrets in it), so a
  // failed send — or a deliberate skip — can be diagnosed from the response
  // instead of guessing.
  let emailed = false
  let emailStatus = alreadyUsed
    ? "already_used"
    : record.unsubscribed
      ? "unsubscribed"
      : alreadyHadCode && !neverSuccessfullyEmailed
        ? "already_sent"
        : "not_configured"
  if (eligibleToSend && env.RESEND_API_KEY) {
    emailStatus = await sendCouponEmail(env.RESEND_API_KEY, email, couponCode)
    emailed = emailStatus === "sent"
    if (emailed) record.couponEmailedAt = new Date().toISOString()
  }

  // Signups never expire — this is a durable list, not a rolling feed.
  await env.ORDERS_KV.put(key, JSON.stringify(record))

  // Also keep a single "subscribers:all" index (newest first, deduped by
  // email) so /admin-subscribers can read it with one get() instead of
  // list()-ing every subscriber: key — see admin-subscribers.ts for why
  // list() must stay off this endpoint.
  try {
    const indexRaw = await env.ORDERS_KV.get("subscribers:all")
    let all: any[] = []
    if (indexRaw) {
      try {
        const parsed = JSON.parse(indexRaw)
        if (Array.isArray(parsed)) all = parsed
      } catch {
        all = []
      }
    }
    all = all.filter((s) => s?.email !== email)
    all.unshift(record)
    await env.ORDERS_KV.put("subscribers:all", JSON.stringify(all))
  } catch (err) {
    console.error("subscribers:all index update failed (signup was still recorded):", (err as Error).message)
  }

  return json({ ok: true, alreadySubscribed: alreadyHadCode, emailed, emailStatus, couponUsed: alreadyUsed })
}

// Unambiguous characters only (no 0/O, 1/I/L) so a code is easy to type.
function newCouponCode(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("")
}

async function sendCouponEmail(apiKey: string, to: string, code: string): Promise<string> {
  const unsubscribeUrl = `https://trendycatch.us/unsubscribe?email=${encodeURIComponent(to)}`
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;color:#2b2230;">
    <h2 style="font-size:22px;margin:0 0 12px;">Welcome to TrendyCatch</h2>
    <p style="font-size:15px;line-height:1.6;">Thanks for signing up. Here is your welcome code:</p>
    <p style="font-size:24px;font-weight:800;letter-spacing:2px;background:#f1eaff;border:1px dashed #5a3ec8;border-radius:12px;padding:14px;text-align:center;color:#43299e;">${code}</p>
    <p style="font-size:15px;line-height:1.6;">It takes 10% off the first 30.00 of your order (up to 3.00 off, in your own currency). Enter it on any product page before you tap Add to cart.</p>
    <p style="font-size:13px;line-height:1.6;color:#6e6480;">One code per email address, valid for one order.</p>
    <p style="font-size:14px;"><a href="https://trendycatch.us/" style="color:#5a3ec8;font-weight:700;">Shop TrendyCatch</a></p>
    <p style="font-size:11px;line-height:1.6;color:#9b93a8;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">You're getting this because you asked for a welcome code at trendycatch.us. <a href="${unsubscribeUrl}" style="color:#9b93a8;">Unsubscribe</a></p>
  </div>`
  try {
    // List-Unsubscribe + List-Unsubscribe-Post (RFC 8058) give Gmail/Yahoo/etc
    // a one-click opt-out they can act on without the customer ever opening
    // the email — mailboxes increasingly use the presence (and use) of this
    // pair as a deliverability signal for anything that looks promotional,
    // and this coupon email is the only promotional mail this domain sends
    // (shipping/confirmation emails are transactional and don't need it).
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "TrendyCatch <orders@trendycatch.us>",
        to: [to],
        subject: "Your TrendyCatch welcome code",
        html,
        headers: {
          "List-Unsubscribe": `<${unsubscribeUrl}>, <mailto:orders@trendycatch.us?subject=unsubscribe>`,
          "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
        },
      }),
    })
    return res.ok ? "sent" : `provider_rejected_${res.status}`
  } catch {
    return "provider_unreachable"
  }
}

function isLikelyEmail(value: string): boolean {
  return /^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/.test(value) && value.length <= 254
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } })
}
