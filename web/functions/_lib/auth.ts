// Shared session/password helpers for the admin dashboard. The leading
// underscore on this folder keeps Cloudflare Pages Functions' router from
// treating it as a route — it's a plain module, imported by admin.html.ts
// and the admin-*.ts endpoints.

export interface AuthEnv {
  ORDERS_KV?: KVNamespace
}

const PASSWORD_KEY = "admin:password"
const SESSION_SECRET_KEY = "admin:session_secret"
const SESSION_COOKIE = "tc_admin_session"
const SESSION_TTL_SECONDS = 60 * 60 * 24 * 14 // 14 days
const PBKDF2_ITERATIONS = 100000

function b64encode(bytes: ArrayBuffer | Uint8Array): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)
  let bin = ""
  for (let i = 0; i < arr.length; i++) bin += String.fromCharCode(arr[i])
  return btoa(bin)
}

function b64decode(str: string): Uint8Array {
  const bin = atob(str)
  const arr = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) arr[i] = bin.charCodeAt(i)
  return arr
}

async function pbkdf2Hash(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const keyMaterial = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt, iterations, hash: "SHA-256" },
    keyMaterial,
    256,
  )
  return new Uint8Array(bits)
}

export async function hasPasswordSet(kv: KVNamespace): Promise<boolean> {
  return (await kv.get(PASSWORD_KEY)) !== null
}

export async function setPassword(kv: KVNamespace, password: string): Promise<void> {
  const salt = crypto.getRandomValues(new Uint8Array(16))
  const hash = await pbkdf2Hash(password, salt, PBKDF2_ITERATIONS)
  await kv.put(
    PASSWORD_KEY,
    JSON.stringify({ salt: b64encode(salt), hash: b64encode(hash), iterations: PBKDF2_ITERATIONS }),
  )
}

export async function verifyPassword(kv: KVNamespace, password: string): Promise<boolean> {
  const raw = await kv.get(PASSWORD_KEY)
  if (!raw) return false
  let parsed: { salt: string; hash: string; iterations: number }
  try {
    parsed = JSON.parse(raw)
  } catch {
    return false
  }
  const candidate = await pbkdf2Hash(password, b64decode(parsed.salt), parsed.iterations)
  const stored = b64decode(parsed.hash)
  if (candidate.length !== stored.length) return false
  let diff = 0
  for (let i = 0; i < candidate.length; i++) diff |= candidate[i] ^ stored[i]
  return diff === 0
}

async function getSessionSecret(kv: KVNamespace): Promise<Uint8Array> {
  let raw = await kv.get(SESSION_SECRET_KEY)
  if (!raw) {
    const secret = crypto.getRandomValues(new Uint8Array(32))
    raw = b64encode(secret)
    // Self-generated, not an external credential — safe to create and persist
    // without any user-supplied config. Best-effort: if two requests race to
    // create it, the loser's signature just won't verify, which is harmless.
    await kv.put(SESSION_SECRET_KEY, raw)
  }
  return b64decode(raw)
}

async function hmac(key: Uint8Array, message: string): Promise<string> {
  const cryptoKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
  const sig = await crypto.subtle.sign("HMAC", cryptoKey, new TextEncoder().encode(message))
  return b64encode(sig)
}

export async function createSessionCookie(kv: KVNamespace): Promise<string> {
  const exp = Date.now() + SESSION_TTL_SECONDS * 1000
  const payload = b64encode(new TextEncoder().encode(JSON.stringify({ exp })))
  const secret = await getSessionSecret(kv)
  const sig = await hmac(secret, payload)
  const value = `${payload}.${sig}`
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=${SESSION_TTL_SECONDS}`
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; Secure; SameSite=Strict; Max-Age=0`
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

export async function hasValidSession(request: Request, kv: KVNamespace): Promise<boolean> {
  const cookies = parseCookies(request.headers.get("Cookie"))
  const value = cookies[SESSION_COOKIE]
  if (!value) return false
  const dot = value.indexOf(".")
  if (dot === -1) return false
  const payload = value.slice(0, dot)
  const sig = value.slice(dot + 1)
  const secret = await getSessionSecret(kv)
  const expected = await hmac(secret, payload)
  if (expected !== sig) return false
  try {
    const { exp } = JSON.parse(new TextDecoder().decode(b64decode(payload)))
    return typeof exp === "number" && exp > Date.now()
  } catch {
    return false
  }
}

// ---- Simple brute-force throttling: a handful of bad attempts per IP locks
// that IP out for a while. Not a substitute for real rate limiting, but it
// raises the bar well above "guess forever against an unprotected endpoint".
const MAX_ATTEMPTS = 5
const LOCKOUT_SECONDS = 60 * 10

export async function isLockedOut(kv: KVNamespace, ip: string): Promise<boolean> {
  const raw = await kv.get(`admin:loginfail:${ip}`)
  return raw !== null && Number(raw) >= MAX_ATTEMPTS
}

export async function recordFailedAttempt(kv: KVNamespace, ip: string): Promise<void> {
  const key = `admin:loginfail:${ip}`
  const raw = await kv.get(key)
  const count = raw ? Number(raw) + 1 : 1
  await kv.put(key, String(count), { expirationTtl: LOCKOUT_SECONDS })
}

export async function clearFailedAttempts(kv: KVNamespace, ip: string): Promise<void> {
  await kv.delete(`admin:loginfail:${ip}`)
}
