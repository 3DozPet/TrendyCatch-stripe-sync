// Shared helpers for the customer-facing "my orders" magic-link login.
// Deliberately kept separate from _lib/auth.ts (the admin dashboard's
// password session): different cookie name, different signing secret, and
// a login token is a different kind of thing from a session — so a bug or
// leak in one system can't be leveraged against the other.
//
// Design, for "hacker safe":
//  - Login tokens are 256-bit random, single-use (deleted from KV the
//    instant they're exchanged), and expire in 15 minutes.
//  - Sessions are a signed, stateless cookie (HMAC over {email, exp}, same
//    technique as the admin session) — nothing to steal from a database,
//    and the HttpOnly+Secure+SameSite=Strict cookie flags mean it's never
//    readable from page JS and never sent cross-site.
//  - Requesting a link never reveals whether an email has any orders
//    (same generic response either way, and response timing is evened out)
//    so this can't be used to enumerate customers.
//  - Both login-link requests and token exchanges are rate-limited per
//    email and per IP.

export interface CustomerAuthEnv {
  ORDERS_KV?: KVNamespace
}

const SESSION_COOKIE = "tc_customer_session"
const SESSION_SECRET_KEY = "customer:session_secret"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 30 // 30 days
const LOGIN_TOKEN_TTL_SECONDS = 60 * 15 // 15 minutes

function b64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((str.length + 3) % 4)
  const bin = atob(padded)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

async function sha256Hex(input: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(input))
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("")
}

async function getSessionSecret(kv: KVNamespace): Promise<Uint8Array> {
  let raw = await kv.get(SESSION_SECRET_KEY)
  if (!raw) {
    raw = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
    await kv.put(SESSION_SECRET_KEY, raw)
  }
  return b64urlDecode(raw)
}

async function hmac(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
  return b64urlEncode(sig)
}

function parseCookies(header: string | null): Record<string, string> {
  const out: Record<string, string> = {}
  if (!header) return out
  for (const part of header.split(";")) {
    const idx = part.indexOf("=")
    if (idx === -1) continue
    out[part.slice(0, idx).trim()] = part.slice(idx + 1).trim()
  }
  return out
}

export async function createCustomerSessionCookie(kv: KVNamespace, email: string): Promise<string> {
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000
  const payload = b64urlEncode(new TextEncoder().encode(JSON.stringify({ email, exp })))
  const sig = await hmac(await getSessionSecret(kv), payload)
  return `${SESSION_COOKIE}=${payload}.${sig}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`
}

export function clearCustomerSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
}

// Returns the signed-in customer's email, or null if there's no valid
// session. Never throws on malformed/tampered cookie input.
export async function getCustomerSession(request: Request, kv: KVNamespace): Promise<string | null> {
  const value = parseCookies(request.headers.get("Cookie"))[SESSION_COOKIE]
  if (!value) return null
  const dot = value.indexOf(".")
  if (dot === -1) return null
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const expected = await hmac(await getSessionSecret(kv), payload)
  if (expected !== sig) return null
  try {
    const { email, exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(payload)))
    if (typeof email !== "string" || typeof exp !== "number" || exp <= Date.now()) return null
    return email
  } catch {
    return null
  }
}

// ---- One-time login-link tokens ----

export async function createLoginToken(kv: KVNamespace, email: string): Promise<string> {
  const token = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  await kv.put(`customer-login-token:${token}`, JSON.stringify({ email, createdAt: Date.now() }), {
    expirationTtl: LOGIN_TOKEN_TTL_SECONDS,
  })
  return token
}

// Single-use: deletes the token as part of reading it, so a link that's
// already been clicked (or guessed, astronomically unlikely at 256 bits of
// entropy) can never be replayed.
export async function consumeLoginToken(kv: KVNamespace, token: string): Promise<string | null> {
  if (!/^[A-Za-z0-9_-]{20,80}$/.test(token)) return null
  const key = `customer-login-token:${token}`
  const raw = await kv.get(key)
  if (!raw) return null
  await kv.delete(key)
  try {
    const { email } = JSON.parse(raw)
    return typeof email === "string" ? email : null
  } catch {
    return null
  }
}

// ---- Throttling: caps how many login links can be requested for one
// email, or from one IP, in a 10-minute window — without ever telling the
// caller that a limit was hit (the login endpoint always replies the same
// way either way, so this can't be probed either).
const THROTTLE_WINDOW_SECONDS = 60 * 10
const MAX_PER_EMAIL = 3
const MAX_PER_IP = 10

async function bumpCounter(kv: KVNamespace, key: string, max: number): Promise<boolean> {
  const raw = await kv.get(key)
  const count = raw ? Number(raw) : 0
  if (count >= max) return false
  await kv.put(key, String(count + 1), { expirationTtl: THROTTLE_WINDOW_SECONDS })
  return true
}

export async function allowLoginRequest(kv: KVNamespace, email: string, ip: string): Promise<boolean> {
  const emailKey = `customer-login-throttle:email:${await sha256Hex(email)}`
  const ipKey = `customer-login-throttle:ip:${ip}`
  const emailOk = await bumpCounter(kv, emailKey, MAX_PER_EMAIL)
  const ipOk = await bumpCounter(kv, ipKey, MAX_PER_IP)
  return emailOk && ipOk
}
