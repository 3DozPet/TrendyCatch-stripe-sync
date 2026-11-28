// GET /admin-inbox        — latest emails customers sent to @trendycatch.us
// GET /admin-inbox?id=... — one email's full text
//
// Read straight from Resend's receiving API (nothing is copied into KV), and
// gated exactly like /admin-subscribers: customer mail is for the store
// owner's eyes only. Only plain text is returned — the dashboard never renders
// a sender's HTML.
import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
  RESEND_API_KEY?: string
}

const API = "https://api.resend.com/emails/receiving"

// The dashboard inbox is the customer inbox: only mail addressed to
// orders@trendycatch.us shows here. Anything sent to another address on the
// domain (e.g. robbie@trendycatch.us, the private admin address) is never
// listed or opened on the dashboard.
const CUSTOMER_ADDRESS = "orders@trendycatch.us"
function isCustomerMail(e: any): boolean {
  const to = Array.isArray(e?.to) ? e.to : [e?.to]
  return to.some((a: unknown) => String(a || "").toLowerCase().includes(CUSTOMER_ADDRESS))
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }
  if (!env.RESEND_API_KEY) {
    return json({ emails: [], error: "Email isn't set up (RESEND_API_KEY missing)." })
  }
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}` }
  const id = new URL(request.url).searchParams.get("id")

  try {
    if (id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400)
      const res = await fetch(`${API}/${id}`, { headers })
      if (!res.ok) return json({ error: providerError(res.status) })
      const e: any = await res.json()
      if (!isCustomerMail(e)) return json({ error: "Not found" }, 404)
      return json({ email: { ...summary(e), text: bodyText(e) } })
    }
    const res = await fetch(`${API}?limit=50`, { headers })
    if (!res.ok) return json({ emails: [], error: providerError(res.status) })
    const data: any = await res.json()
    const emails = (Array.isArray(data?.data) ? data.data : []).filter(isCustomerMail).slice(0, 25).map(summary)
    return json({ emails, count: emails.length })
  } catch {
    return json({ emails: [], error: "Couldn't reach the email provider — try again shortly." })
  }
}

function summary(e: any) {
  return {
    id: String(e?.id || ""),
    from: String(e?.from || ""),
    to: Array.isArray(e?.to) ? e.to.join(", ") : String(e?.to || ""),
    subject: String(e?.subject || "(no subject)"),
    createdAt: String(e?.created_at || ""),
    attachments: Array.isArray(e?.attachments) ? e.attachments.length : 0,
    messageId: String(e?.message_id || ""),
  }
}

function bodyText(e: any): string {
  if (typeof e?.text === "string" && e.text.trim()) return e.text.slice(0, 20000)
  const html = typeof e?.html === "string" ? e.html : ""
  return html
    .replace(/<(style|script)[\s\S]*?<\/\1>/gi, "")
    .replace(/<br\s*\/?>|<\/p>|<\/div>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, 20000)
}

function providerError(status: number): string {
  if (status === 401 || status === 403) {
    return "The email key on this site can send but isn't allowed to read incoming mail — it needs a full-access Resend API key."
  }
  return `Email provider returned ${status}.`
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  })
}
