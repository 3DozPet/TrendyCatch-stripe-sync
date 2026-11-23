// Cloudflare Pages only runs the login/session gate in admin.html.ts for
// requests whose literal path is /admin.html. A request to /admin (no
// extension) doesn't match that function route, so it falls straight
// through to the static admin.html asset with no auth check at all — the
// dashboard's JS then loads unauthenticated, every admin-* API call 401s,
// and reloadIfUnauthorized() reloads the page in a loop (the "flickering" /
// "black page" / "can't log in" symptoms). Redirecting here closes that gap
// by sending /admin through /admin.html, where the real gate runs.
export const onRequestGet: PagesFunction = async () => {
  return new Response(null, { status: 302, headers: { Location: "/admin.html" } })
}
