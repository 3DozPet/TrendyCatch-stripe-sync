// POST /admin-create-coupon — lets the dashboard issue a one-off, customer-
// specific discount code: either a percent off (with an optional dollar cap)
// or a flat dollar amount off. Distinct from the automatic welcome coupon
// (one per new subscriber, fixed 10%-off-first-$30, issued by /subscribe) —
// this one is admin-initiated, any amount, any customer, any time.
//
// Stores straight into the same `coupon:<code>` KV shape /create-checkout
// already reads, but with explicit discountType/value/maxDiscount fields on
// the record. A coupon record with NO discountType (every code issued by
// /subscribe before this endpoint existed) still falls back to the original
// hardcoded 10%/$30 welcome-coupon math in create-checkout.ts — this never
// touches or reinterprets those.
//
// Code format: "TC-" + 8 chars, matching the longer half of create-checkout's
// existing `/^(TC-[A-Z0-9]{8}|[A-Z0-9]{6})$/` validation (that pattern already
// accepted this shape for older coupons), so the generated code needs no
// change to the redemption side beyond reading the new fields.
import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
  RESEND_API_KEY?: string
}

const MAX_PERCENT = 100
const MAX_AMOUNT = 1000 // sanity ceiling in dollars — catches a fat-fingered extra zero

export const onRequestPost: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV) return json({ error: "ORDERS_KV not bound" }, 503)
  if (!(await hasValidSession(request, env.ORDERS_KV))) return json({ error: "Unauthorized" }, 401)
  const origin = request.headers.get("Origin")
  if (!origin || origin !== new URL(request.url).origin) return json({ error: "Invalid request origin" }, 403)

  let input: any
  try {
    input = await request.json()
  } catch {
    return json({ error: "Invalid request" }, 400)
  }

  const email = (typeof input.email === "string" ? input.email : "").trim().toLowerCase()
  if (!/^[^\s@<>"'&]+@[^\s@<>"'&]+\.[^\s@<>"'&]+$/.test(email) || email.length > 254) {
    return json({ error: "That email address doesn't look right." }, 400)
  }

  const discountType = input.discountType === "amount" ? "amount" : input.discountType === "percent" ? "percent" : null
  if (!discountType) return json({ error: "discountType must be 'percent' or 'amount'" }, 400)

  const value = Number(input.value)
  if (!Number.isFinite(value) || value <= 0) return json({ error: "value must be a positive number" }, 400)
  if (discountType === "percent" && value > MAX_PERCENT) return json({ error: `Percent can't be more than ${MAX_PERCENT}` }, 400)
  if (discountType === "amount" && value > MAX_AMOUNT) return json({ error: `That's a bigger discount than this form allows (max $${MAX_AMOUNT})` }, 400)

  let maxDiscount: number | null = null
  if (discountType === "percent" && input.maxDiscount != null && input.maxDiscount !== "") {
    const parsed = Number(input.maxDiscount)
    if (!Number.isFinite(parsed) || parsed <= 0) return json({ error: "maxDiscount must be a positive number, or left blank for no cap" }, 400)
    maxDiscount = parsed
  }

  const note = typeof input.note === "string" ? input.note.trim().slice(0, 300) : ""
  const sendEmail = input.sendEmail !== false // default true

  const code = "TC-" + newSuffix()
  const record = {
    subscriberKey: `subscriber:${await sha256Hex(email)}`,
    customerEmail: email,
    status: "unused",
    createdAt: new Date().toISOString(),
    createdBy: "admin",
    discountType,
    value,
    maxDiscount,
    note: note || null,
  }
  await env.ORDERS_KV.put(`coupon:${code}`, JSON.stringify(record))

  let emailStatus: string | null = null
  if (sendEmail) {
    if (!env.RESEND_API_KEY) {
      emailStatus = "not_configured"
    } else {
      emailStatus = await sendCustomCouponEmail(env.RESEND_API_KEY, email, code, discountType, value, maxDiscount, note)
    }
  }

  return json({ ok: true, code, emailed: emailStatus === "sent", emailStatus })
}

// Same restricted alphabet as the public signup coupon generator (no 0/O/1/I/L).
function newSuffix(): string {
  const alphabet = "ABCDEFGHJKMNPQRSTUVWXYZ23456789"
  const bytes = crypto.getRandomValues(new Uint8Array(8))
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join("")
}

function describeDiscount(discountType: string, value: number, maxDiscount: number | null): string {
  if (discountType === "amount") return `$${value.toFixed(2)} off your order`
  return maxDiscount ? `${value}% off (up to $${maxDiscount.toFixed(2)})` : `${value}% off your order`
}

async function sendCustomCouponEmail(apiKey: string, to: string, code: string, discountType: string, value: number, maxDiscount: number | null, note: string): Promise<string> {
  const description = describeDiscount(discountType, value, maxDiscount)
  const unsubscribeUrl = `https://trendycatch.us/unsubscribe?email=${encodeURIComponent(to)}`
  const html = `<div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;max-width:520px;margin:0 auto;color:#2b2230;">
    <h2 style="font-size:22px;margin:0 0 12px;">A discount code for you</h2>
    ${note ? `<p style="font-size:15px;line-height:1.6;">${escapeHtml(note)}</p>` : `<p style="font-size:15px;line-height:1.6;">Here's a code for your next TrendyCatch order:</p>`}
    <p style="font-size:24px;font-weight:800;letter-spacing:2px;background:#f1eaff;border:1px dashed #5a3ec8;border-radius:12px;padding:14px;text-align:center;color:#43299e;">${code}</p>
    <p style="font-size:15px;line-height:1.6;">It takes <strong>${escapeHtml(description)}</strong>. Enter it on any product page before you tap Add to cart.</p>
    <p style="font-size:13px;line-height:1.6;color:#6e6480;">One code, valid for one order.</p>
    <p style="font-size:14px;"><a href="https://trendycatch.us/" style="color:#5a3ec8;font-weight:700;">Shop TrendyCatch</a></p>
    <p style="font-size:11px;line-height:1.6;color:#9b93a8;margin-top:24px;border-top:1px solid #eee;padding-top:12px;">You're getting this from TrendyCatch. <a href="${unsubscribeUrl}" style="color:#9b93a8;">Unsubscribe</a></p>
  </div>`
  try {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey.trim()}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from: "TrendyCatch <orders@trendycatch.us>",
        to: [to],
        subject: "A discount code from TrendyCatch",
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

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string))
}

async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input)
  const digest = await crypto.subtle.digest("SHA-256", data)
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } })
}
