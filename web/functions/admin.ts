// Gatekeeper for GET /admin (the bare, extensionless URL used throughout the
// app and in links given to the owner). Cloudflare Pages Functions route by
// literal file path, so a file named admin.html.ts only intercepts the exact
// path /admin.html — a request to /admin falls straight through to the raw,
// unauthenticated static asset otherwise. This file closes that gap by
// running the exact same gate check in-process (see adminGateResponse in
// admin.html.ts) rather than redirecting to /admin.html.
//
// Do NOT change this back to a redirect to /admin.html. That was tried and
// caused an infinite redirect loop (ERR_TOO_MANY_REDIRECTS) once logged in:
// an authed request to /admin.html falls through via next() to Cloudflare's
// static-asset layer, which canonicalizes straight .html requests by
// redirecting them to the extensionless path (/admin.html -> /admin); a
// redirect here back to /admin.html would then bounce forever against that.
import { adminGateResponse } from "./admin.html"

interface Env {
  ORDERS_KV?: KVNamespace
}

export const onRequestGet: PagesFunction<Env> = async ({ request, env, next }) => {
  const gate = await adminGateResponse(request, env)
  if (gate) return gate
  return next()
}
