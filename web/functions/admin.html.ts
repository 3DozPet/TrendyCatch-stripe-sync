// Route file for GET /admin.html. All the actual gate logic lives in
// _lib/admin-gate.ts — NOT inlined here and NOT imported from admin.ts (or
// vice versa). Cloudflare Pages Functions bundles/tree-shakes each route file
// independently, so one route file importing a named export from another
// route file breaks at publish time ("does not provide an export named
// ...") even though it typechecks fine locally. That was tried (admin.ts
// importing from this file) and the deploy failed with exactly that error.
// Shared logic between routes must live in a non-route _lib/ module.
import { adminGateResponse, type AdminGateEnv } from "./_lib/admin-gate"

export const onRequestGet: PagesFunction<AdminGateEnv> = async ({ request, env, next }) => {
  const gate = await adminGateResponse(request, env)
  if (gate) return gate
  return next()
}
