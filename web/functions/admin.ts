// Gatekeeper for GET /admin (the bare, extensionless URL used throughout the
// app and in links given to the owner). Cloudflare Pages Functions route by
// literal file path, so a file named admin.html.ts only intercepts the exact
// path /admin.html — a request to /admin falls straight through to the raw,
// unauthenticated static asset otherwise. This file closes that gap by
// running the same gate check as admin.html.ts (from _lib/admin-gate.ts, a
// non-route shared module — see that file's and admin.html.ts's comments for
// why it must not be imported directly from admin.html.ts instead).
//
// Do NOT change this back to a redirect to /admin.html. That was tried and
// caused an infinite redirect loop (ERR_TOO_MANY_REDIRECTS) once logged in:
// an authed request to /admin.html falls through via next() to Cloudflare's
// static-asset layer, which canonicalizes straight .html requests by
// redirecting them to the extensionless path (/admin.html -> /admin); a
// redirect here back to /admin.html would then bounce forever against that.
import { adminGateResponse, type AdminGateEnv } from "./_lib/admin-gate"

export const onRequestGet: PagesFunction<AdminGateEnv> = async ({ request, env, next }) => {
  const gate = await adminGateResponse(request, env)
  if (gate) return gate
  return next()
}
