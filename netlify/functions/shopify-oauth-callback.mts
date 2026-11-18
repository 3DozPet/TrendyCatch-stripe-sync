import type { Config, Context } from "@netlify/functions"

// One-time-use helper: completes the Shopify OAuth code exchange so we can
// obtain a real offline Admin API access token for this custom app.
// Visit /shopify-install first to kick off the flow, approve on Shopify,
// and you'll land back here with the token displayed once.
// Delete or ignore this file after setup - it's not part of the live
// Stripe sync and carries no risk by itself (it only ever uses the
// configured client id/secret to complete a flow Shopify itself started).

export default async (req: Request, context: Context) => {
  const url = new URL(req.url)

  if (url.pathname === "/shopify-install") {
    const shop = Netlify.env.get("SHOPIFY_STORE_DOMAIN")
    const clientId = Netlify.env.get("SHOPIFY_CLIENT_ID")
    const scopes = "read_orders,write_orders,read_customers"
    const redirectUri = `${url.origin}/shopify-oauth-callback`
    if (!shop || !clientId) {
      return new Response("Missing SHOPIFY_STORE_DOMAIN or SHOPIFY_CLIENT_ID env vars", { status: 500 })
    }
    const authorizeUrl = `https://${shop}/admin/oauth/authorize?client_id=${clientId}&scope=${encodeURIComponent(scopes)}&redirect_uri=${encodeURIComponent(redirectUri)}&state=setup123`
    return Response.redirect(authorizeUrl, 302)
  }

  const code = url.searchParams.get("code")
  const shop = url.searchParams.get("shop")
  const clientId = Netlify.env.get("SHOPIFY_CLIENT_ID")
  const clientSecret = Netlify.env.get("SHOPIFY_CLIENT_SECRET")

  if (!code || !shop) {
    return new Response("Missing code or shop param. Start at /shopify-install instead.", { status: 400 })
  }
  if (!clientId || !clientSecret) {
    return new Response("Missing SHOPIFY_CLIENT_ID or SHOPIFY_CLIENT_SECRET env vars", { status: 500 })
  }

  const tokenRes = await fetch(`https://${shop}/admin/oauth/access_token`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client_id: clientId, client_secret: clientSecret, code }),
  })

  const text = await tokenRes.text()
  if (!tokenRes.ok) {
    return new Response(`Token exchange failed: ${tokenRes.status} ${text}`, { status: 502 })
  }

  return new Response(text, {
    status: 200,
    headers: { "content-type": "application/json" },
  })
}

export const config: Config = {
  path: ["/shopify-install", "/shopify-oauth-callback"],
}
