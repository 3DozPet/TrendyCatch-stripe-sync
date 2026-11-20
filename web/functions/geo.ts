// GET /geo — tells the page which of our 4 markets the visitor is in, using
// Cloudflare's own edge geolocation (request.cf.country), the same trick used
// on the LunaHug/Pureglow pages. Falls back to AU for anywhere we don't sell to.
interface CfRequest extends Request {
  cf?: { country?: string }
}

const SUPPORTED = new Set(["AU", "NZ", "US", "CA"])

export const onRequestGet: PagesFunction = async ({ request }) => {
  const country = (request as CfRequest).cf?.country ?? "AU"
  const resolved = SUPPORTED.has(country) ? country : "AU"
  return new Response(JSON.stringify({ country: resolved }), {
    headers: { "content-type": "application/json" },
  })
}
