// POST /admin-logout — clears the session cookie.
import { clearSessionCookie } from "./_lib/auth"

export const onRequestPost: PagesFunction = async () => {
  return new Response(JSON.stringify({ ok: true }), {
    status: 200,
    headers: { "content-type": "application/json", "set-cookie": clearSessionCookie() },
  })
}
