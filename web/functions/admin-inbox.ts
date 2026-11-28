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

// Everything this mailbox has sent, newest first, from Resend's sent log
// (no bodies — the list endpoint doesn't carry them). Returns [] on any
// problem, e.g. an API key that can send but can't read the log, so callers
// fall back to this dashboard's own KV copy.
async function listSent(headers: Record<string, string>, mailboxAddress: string): Promise<any[]> {
  const res = await fetch(`${SENT_API}?limit=100`, { headers })
  if (!res.ok) return []
  const data: any = await res.json()
  return (Array.isArray(data?.data) ? data.data : [])
    .filter((m: any) => extractAddress(m?.from) === mailboxAddress)
    .map((m: any) => ({
      id: String(m?.id || ""),
      from: String(m?.from || ""),
      to: recipients(m),
      subject: String(m?.subject || ""),
      createdAt: isoTime(m?.created_at),
    }))
    .sort((a: any, b: any) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))
}

async function fetchSentBody(headers: Record<string, string>, id: string): Promise<any> {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const r = await fetch(`${SENT_API}/${encodeURIComponent(id)}`, { headers })
      if (r.ok) return await r.json()
      if (r.status !== 429) return null
      await new Promise((resolve) => setTimeout(resolve, 600))
    } catch {
      return null
    }
  }
  return null
}

// Thread entries for the newest few sends to one address. Bodies cost a
// request each, hence SENT_BODY_LIMIT.
async function sentToAddress(
  headers: Record<string, string>,
  sent: any[],
  correspondent: string,
): Promise<any[]> {
  const mine = sent
    .filter((m) => m.to.some((a: string) => extractAddress(a) === correspondent))
    .slice(0, SENT_BODY_LIMIT)
  // Resend rate-limits around 2 requests/second, so these go two at a time
  // with one retry on a 429 — firing all of them at once gets some rejected
  // and silently leaves those messages with no text.
  const bodies: any[] = []
  for (let i = 0; i < mine.length; i += 2) {
    const chunk = await Promise.all(mine.slice(i, i + 2).map((m) => fetchSentBody(headers, m.id)))
    bodies.push(...chunk)
  }
  return mine.map((m, i) => ({
    direction: "out",
    from: m.from,
    to: m.to.join(", "),
    subject: m.subject,
    text: bodies[i] ? bodyText(bodies[i]) : "",
    createdAt: m.createdAt,
  }))
}

// This dashboard's own log of what it sent (admin-inbox-reply.ts). Readable
// the instant a reply is sent, while Resend's list can lag behind.
async function sentFromKv(env: Env, mailbox: string, correspondent: string): Promise<any[]> {
  if (!env.ORDERS_KV) return []
  try {
    const raw = await env.ORDERS_KV.get(`sentmail:${mailbox}:${correspondent}`)
    if (!raw) return []
    const sent = JSON.parse(raw)
    if (!Array.isArray(sent)) return []
    return sent.map((s: any) => ({
      direction: "out",
      from: String(s?.from || ""),
      to: String(s?.to || ""),
      subject: String(s?.subject || ""),
      text: String(s?.text || ""),
      createdAt: isoTime(s?.createdAt),
    }))
  } catch {
    return []
  }
}

// Resend's sent log returns timestamps like "2026-11-28 02:41:41.077000+00"
// — a space instead of T, microseconds, and a bare "+00" offset. V8 parses
// that leniently, so it looks fine in Chrome, but WebKit (i.e. every
// browser on iOS) returns NaN for it, which would leave the dashboard
// showing no usable time on those entries and sorting them unpredictably.
// Hand the front end canonical ISO 8601 instead.
function isoTime(value: unknown): string {
  const raw = String(value || "").trim()
  if (!raw) return ""
  const candidate = raw
    .replace(" ", "T")
    .replace(/(\.\d{3})\d+/, "$1")
    .replace(/([+-]\d\d)$/, "$1:00")
  const ms = Date.parse(candidate)
  return Number.isFinite(ms) ? new Date(ms).toISOString() : raw
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
  const threadWith = url.searchParams.get("thread")
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
        { direction: "in", from: String(e?.from || ""), to: address, text: inboundText, createdAt: isoTime(e?.created_at) },
      ]
      const correspondent = extractAddress(e?.from)
      if (correspondent) {
        let fromResend: any[] = []
        try {
          fromResend = await sentToAddress(headers, await listSent(headers, address), correspondent)
        } catch {
          // Resend's sent log is unreadable right now — the KV copy still
          // covers anything sent from this dashboard.
        }
        thread.push(...mergeSent(fromResend, await sentFromKv(env, mailbox, correspondent)))
      }
      thread.sort((a, b) => Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""))
      return json({ email: { ...summary(e), text: inboundText, thread } })
    }

    // ?thread=<address> — a conversation that exists only outbound: someone
    // this mailbox wrote to who has never written back, so there's no
    // inbound email to look up by id.
    if (threadWith) {
      const correspondent = extractAddress(threadWith)
      if (!/^[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+$/.test(correspondent)) {
        return json({ error: "bad address" }, 400)
      }
      let fromResend: any[] = []
      try {
        fromResend = await sentToAddress(headers, await listSent(headers, address), correspondent)
      } catch {
        // Falls back to the KV copy below.
      }
      const thread = mergeSent(fromResend, await sentFromKv(env, mailbox, correspondent))
        .sort((a, b) => Date.parse(a.createdAt || "") - Date.parse(b.createdAt || ""))
      if (!thread.length) return json({ error: "Nothing sent to this address yet." })
      const newest = thread[thread.length - 1]
      return json({
        email: {
          id: `sent:${correspondent}`,
          outgoing: true,
          from: correspondent,
          to: address,
          subject: newest.subject || "(no subject)",
          createdAt: newest.createdAt,
          attachments: 0,
          messageId: "",
          text: newest.text || "",
          thread,
        },
      })
    }
    const res = await fetch(`${API}?limit=50`, { headers })
    if (!res.ok) return json({ emails: [], error: providerError(res.status) })
    const data: any = await res.json()
    const inbound = (Array.isArray(data?.data) ? data.data : [])
      .filter((e: any) => matchesMailbox(e, address))
      .slice(0, 25)
      .map(summary)

    // Newest send per correspondent, so a thread can show that it's been
    // answered without having to be opened.
    let sent: any[] = []
    try {
      sent = await listSent(headers, address)
    } catch {
      // Sent log unreadable — the list just loses its "replied" markers.
    }
    const perAddress = new Map<string, { at: string; count: number; subject: string }>()
    for (const m of sent) {
      for (const a of m.to) {
        const addr = extractAddress(a)
        if (!addr) continue
        const prev = perAddress.get(addr)
        if (!prev) {
          perAddress.set(addr, { at: m.createdAt, count: 1, subject: m.subject })
        } else if (Date.parse(m.createdAt || "") > Date.parse(prev.at || "")) {
          perAddress.set(addr, { at: m.createdAt, count: prev.count + 1, subject: m.subject })
        } else {
          perAddress.set(addr, { ...prev, count: prev.count + 1 })
        }
      }
    }
    const emails = inbound.map((e: any) => {
      const info = perAddress.get(extractAddress(e.from))
      return info ? { ...e, repliedAt: info.at, sentCount: info.count } : e
    })

    // Conversations that exist only outbound — someone written to who has
    // never written in — have no inbound email to hang off, so without this
    // they'd be invisible here even though Resend has them. Admin mailbox
    // only: orders@ also sends every automated order and shipping email,
    // which belongs in the Sent emails panel, not in the customer inbox.
    if (mailbox === "admin") {
      const known = new Set(inbound.map((e: any) => extractAddress(e.from)))
      for (const [addr, info] of perAddress) {
        if (known.has(addr)) continue
        emails.push({
          id: `sent:${addr}`,
          outgoing: true,
          from: addr,
          to: address,
          subject: info.subject || "(no subject)",
          createdAt: info.at,
          attachments: 0,
          messageId: "",
          repliedAt: info.at,
          sentCount: info.count,
        })
      }
      emails.sort((a: any, b: any) => Date.parse(b.createdAt || "") - Date.parse(a.createdAt || ""))
    }
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
