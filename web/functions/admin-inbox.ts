// GET /admin-inbox                  — latest customer emails (orders@)
// GET /admin-inbox?mailbox=admin    — latest emails to robbie@ (separate,
//                                     admin-only "Admin inbox" panel)
// GET /admin-inbox?id=...           — one email's full text (pass the same
//                                     &mailbox= it was listed under)
//
// Read straight from Resend's receiving API — inbound mail itself is never
// copied into KV — and gated exactly like /admin-subscribers: this is for
// the store owner's eyes only (valid dashboard session required) — not
// visible to anyone else, e.g. Robbie himself has no separate login here.
// Two separate mailboxes, kept apart on the dashboard: the customer-facing
// one (orders@trendycatch.us) and Robbie's own (robbie@trendycatch.us) —
// never merged into one list.
//
// Opening a single email (?id=...) builds a `thread` array (oldest first)
// of the whole correspondence with that sender, from two sources:
//
//   1. Resend's own sent-email log (GET /emails, then GET /emails/<id> for
//      the bodies), filtered to mail this mailbox sent to that address. This
//      is what makes the dashboard show the same thread Resend does — it
//      covers replies sent before this dashboard kept its own copy, and
//      anything sent straight from Resend rather than from here.
//   2. This dashboard's own log of sends (admin-inbox-reply.ts writes
//      `sentmail:<mailbox>:<address>` in KV). Kept because it's readable the
//      instant a reply is sent, while Resend's list can lag behind, and
//      because it still works if the API key can't read the sent log.
//
// Entries present in both are merged, not shown twice. One KV get() per
// thread opened — not a list() — so no risk to the daily list() cap
// admin-orders.ts ran into.
//
// The admin mailbox can carry one more lock on top of the normal dashboard
// session: a second password (ADMIN_INBOX_KEY, a Cloudflare secret — never
// committed here) sent as the X-Admin-Key header. That lock only applies
// once the store owner actually sets the secret in Cloudflare; until then
// this mailbox behaves like the customer one — no second password asked
// for, same as any other panel behind the regular dashboard login.
import { hasValidSession } from "./_lib/auth"

interface Env {
  ORDERS_KV?: KVNamespace
  RESEND_API_KEY?: string
  ADMIN_INBOX_KEY?: string
}

const API = "https://api.resend.com/emails/receiving"
// Resend's sent-email endpoints: GET /emails lists sent mail (no bodies —
// those need GET /emails/<id>), capped at limit=100 per call.
const SENT_API = "https://api.resend.com/emails"
// Bodies cost one request each, so only the newest few in a thread get one.
const SENT_BODY_LIMIT = 6

const MAILBOXES: Record<string, string> = {
  customer: "orders@trendycatch.us",
  admin: "robbie@trendycatch.us",
}
function addressFor(mailbox: string): string {
  return MAILBOXES[mailbox] || MAILBOXES.customer
}
function matchesMailbox(e: any, address: string): boolean {
  const to = Array.isArray(e?.to) ? e.to : [e?.to]
  return to.some((a: unknown) => String(a || "").toLowerCase().includes(address))
}
function extractAddress(from: string): string {
  const m = String(from || "").match(/<([^<>]+)>/)
  return (m ? m[1] : String(from || "")).trim().toLowerCase()
}
function recipients(e: any): string[] {
  return (Array.isArray(e?.to) ? e.to : [e?.to]).map((a: unknown) => String(a || "").toLowerCase())
}

// Everything this mailbox has sent to one address, newest-first, straight
// from Resend's sent log. Returns [] on any problem (e.g. an API key that
// can send but can't read the log) so the thread falls back to the KV copy.
async function sentFromResend(
  headers: Record<string, string>,
  mailboxAddress: string,
  correspondent: string,
): Promise<any[]> {
  const res = await fetch(`${SENT_API}?limit=100`, { headers })
  if (!res.ok) return []
  const data: any = await res.json()
  const mine = (Array.isArray(data?.data) ? data.data : [])
    .filter(
      (m: any) =>
        extractAddress(m?.from) === mailboxAddress &&
        recipients(m).some((a) => a.includes(correspondent)),
    )
    .sort((a: any, b: any) => Date.parse(b?.created_at || "") - Date.parse(a?.created_at || ""))
    .slice(0, SENT_BODY_LIMIT)

  const bodies = await Promise.all(
    mine.map(async (m: any) => {
      try {
        const r = await fetch(`${SENT_API}/${encodeURIComponent(String(m?.id || ""))}`, { headers })
        return r.ok ? await r.json() : null
      } catch {
        return null
      }
    }),
  )
  return mine.map((m: any, i: number) => ({
    direction: "out",
    from: String(m?.from || ""),
    to: recipients(m).join(", "),
    subject: String(m?.subject || ""),
    text: bodies[i] ? bodyText(bodies[i]) : "",
    createdAt: String(m?.created_at || ""),
  }))
}

function normalizeText(text: string): string {
  return String(text || "").replace(/\s+/g, " ").trim()
}
// Same send seen through both sources: identical body, or — when Resend's
// body couldn't be fetched — the same recipient at near-identical times.
function sameMessage(a: any, b: any): boolean {
  const ta = normalizeText(a?.text)
  const tb = normalizeText(b?.text)
  if (ta && tb) return ta === tb
  const da = Date.parse(a?.createdAt || "")
  const db = Date.parse(b?.createdAt || "")
  return Number.isFinite(da) && Number.isFinite(db) && Math.abs(da - db) < 120000
}
// Resend's record wins on metadata, the KV copy fills in a body Resend
// didn't hand back, and anything only one source knows about is kept.
function mergeSent(fromResend: any[], fromKv: any[]): any[] {
  const used = new Set<number>()
  const merged = fromResend.map((r) => {
    const i = fromKv.findIndex((k, idx) => !used.has(idx) && sameMessage(k, r))
    if (i === -1) return r
    used.add(i)
    return { ...r, text: r.text || fromKv[i].text, subject: r.subject || fromKv[i].subject }
  })
  fromKv.forEach((k, i) => { if (!used.has(i)) merged.push(k) })
  return merged
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env }) => {
  if (!env.ORDERS_KV || !(await hasValidSession(request, env.ORDERS_KV))) {
    return json({ error: "unauthorized" }, 401)
  }
  const url = new URL(request.url)
  const mailbox = url.searchParams.get("mailbox") || "customer"
  if (mailbox === "admin" && env.ADMIN_INBOX_KEY) {
    const given = request.headers.get("X-Admin-Key") || ""
    if (given !== env.ADMIN_INBOX_KEY) return json({ error: "wrong_password" }, 403)
  }
  if (!env.RESEND_API_KEY) {
    return json({ emails: [], error: "Email isn't set up (RESEND_API_KEY missing)." })
  }
  const headers = { Authorization: `Bearer ${env.RESEND_API_KEY}` }
  const id = url.searchParams.get("id")
  const address = addressFor(mailbox)

  try {
    if (id) {
      if (!/^[0-9a-f-]{36}$/i.test(id)) return json({ error: "bad id" }, 400)
      const res = await fetch(`${API}/${id}`, { headers })
      if (!res.ok) return json({ error: providerError(res.status) })
      const e: any = await res.json()
      if (!matchesMailbox(e, address)) return json({ error: "Not found" }, 404)
      const inboundText = bodyText(e)
      const thread: any[] = [
        { direction: "in", from: String(e?.from || ""), to: address, text: inboundText, createdAt: String(e?.created_at || "") },
      ]
      const correspondent = extractAddress(e?.from)
      if (correspondent) {
        let fromResend: any[] = []
        try {
          fromResend = await sentFromResend(headers, address, correspondent)
        } catch {
          // Resend's sent log is unreadable right now — the KV copy below
          // still covers anything sent from this dashboard.
        }
        let fromKv: any[] = []
        if (env.ORDERS_KV) {
          try {
            const raw = await env.ORDERS_KV.get(`sentmail:${mailbox}:${correspondent}`)
            if (raw) {
              const sent = JSON.parse(raw)
              if (Array.isArray(sent)) {
                fromKv = sent.map((s: any) => ({
                  direction: "out",
                  from: String(s?.from || ""),
                  to: String(s?.to || ""),
                  subject: String(s?.subject || ""),
                  text: String(s?.text || ""),
                  createdAt: String(s?.createdAt || ""),
                }))
              }
            }
          } catch {
            // Best-effort — fall back to whatever Resend gave us.
          }
        }
        thread.push(...mergeSent(fromResend, fromKv))
      }
      thread.sort((a, b) => Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""))
      return json({ email: { ...summary(e), text: inboundText, thread } })
    }
    const res = await fetch(`${API}?limit=50`, { headers })
    if (!res.ok) return json({ emails: [], error: providerError(res.status) })
    const data: any = await res.json()
    const emails = (Array.isArray(data?.data) ? data.data : [])
      .filter((e: any) => matchesMailbox(e, address))
      .slice(0, 25)
      .map(summary)
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
