import type { Config, Context } from "@netlify/functions"
import { randomUUID } from "node:crypto"
import { attributionStore, pureGlowOrigin } from "../lib/pureglow-attribution"

export const config: Config = { path: "/pureglow-attribution" }

const responseHeaders = {
  "Access-Control-Allow-Origin": pureGlowOrigin,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type",
  "Cache-Control": "no-store",
  Vary: "Origin",
}

function matchingString(value: unknown, format: RegExp) {
  return typeof value === "string" && format.test(value) ? value : undefined
}

export default async function handler(request: Request, context: Context) {
  if (request.headers.get("origin") !== pureGlowOrigin) return new Response(null, { status: 403 })
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: responseHeaders })
  if (request.method !== "POST") return new Response(null, { status: 405, headers: responseHeaders })

  try {
    const body = await request.text()
    if (body.length > 4096) return new Response(null, { status: 413, headers: responseHeaders })
    let input
    try { input = JSON.parse(body) } catch { return new Response(null, { status: 400, headers: responseHeaders }) }
    const ttclid = matchingString(input?.ttclid, /^[A-Za-z0-9._-]{1,1024}$/)
    const fbc = matchingString(input?.fbc, /^fb\.\d+\.\d{13}\.[A-Za-z0-9._-]{1,1024}$/)
    const fbp = matchingString(input?.fbp, /^fb\.\d+\.\d{13}\.\d{1,24}$/)
    if (!ttclid && !fbc && !fbp) return new Response(null, { status: 400, headers: responseHeaders })

    const reference = "pg_" + randomUUID().replace(/-/g, "")
    await attributionStore().setJSON(reference, {
      ttclid, fbc, fbp, ip: context.ip,
      userAgent: request.headers.get("user-agent")?.slice(0, 512),
      capturedAt: Date.now(),
    })
    return Response.json({ reference }, { headers: responseHeaders })
  } catch {
    console.error("PureGlow checkout attribution storage failed")
    return new Response(null, { status: 503, headers: responseHeaders })
  }
}
