# trendycatch.us — Cloudflare Pages site

Multi-product dropshipping landing page for TrendyCatch, built as a
Cloudflare Pages site with Pages Functions. Lives in this repo's `/web`
directory alongside the existing `netlify/functions/` (which keeps serving
Pureglow Clearance — untouched).

## What's here

| File | Purpose |
|---|---|
| `index.html` | Main landing page — 15 products, geo-based AU/NZ/US/CA pricing, Buy Now buttons, Meta/TikTok/Google pixels |
| `admin.html` | Live order feed — polls for new orders every 5s and plays a synthesized chime; shows each order's ad-platform source |
| `thank-you.html` | Stripe `success_url` destination |
| `products.json` | The 15 products: title, "hook" description, variant, per-country prices |
| `functions/geo.ts` | `GET /geo` — Cloudflare edge country detection |
| `functions/config.ts` | `GET /config` — public pixel/tag IDs, read from env |
| `functions/create-checkout.ts` | `POST /create-checkout` — builds a Stripe Checkout Session server-side (price is always re-read from `products.json`, never trusted from the client) |
| `functions/stripe-order-sync.ts` | `POST /stripe-order-sync` — Stripe webhook; creates the paid Shopify order, tags it, fires Meta/TikTok/GA4 server-side Purchase events, and writes the order-alert entry for `admin.html` |
| `functions/admin-orders.ts` | `GET /admin-orders` — feeds `admin.html` from KV |

## How an order flows

1. Visitor lands on `index.html`. The page detects their country via `/geo`
   and which ad platform they arrived from (UTM params, each network's
   click-id param — `fbclid`, `ttclid`, `gclid`, etc. — or the referrer),
   stored for the session.
2. They click **Buy Now** → `POST /create-checkout` with the product id,
   country and detected source → a Stripe Checkout Session is created and
   they're redirected to Stripe's hosted page, which collects full name,
   email, phone and shipping address.
3. On payment, Stripe calls the `stripe-order-sync` webhook, which:
   - creates a **paid, unfulfilled** Shopify order tagged `TrendyCatch`,
     `stripe-auto-sync`, a dedup hash tag, and `source-<platform>`;
   - fires server-side **Purchase** events to Meta CAPI, TikTok Events API
     and GA4 Measurement Protocol;
   - writes a short-lived entry to KV so `admin.html` can show it live.
4. `admin.html` (open it on a screen near you) polls every 5 seconds and
   plays a chime for each new order, showing the customer, items, total and
   **which platform it came from** — Facebook, Instagram, TikTok, Google,
   YouTube, etc. — right in the order card.

## Required environment variables (set in Cloudflare Pages → Settings → Environment variables)

| Variable | Used by | Required? |
|---|---|---|
| `STRIPE_SECRET_KEY` | create-checkout, stripe-order-sync | Yes |
| `STRIPE_WEBHOOK_SECRET` | stripe-order-sync | Yes |
| `SHOPIFY_STORE_DOMAIN` | stripe-order-sync | Yes (e.g. `3doz.myshopify.com`) |
| `SHOPIFY_ADMIN_TOKEN` | stripe-order-sync | Yes |
| `ORDER_EMAIL` | stripe-order-sync | No (defaults to `support@3doz.pet`) |
| `SITE_URL` | create-checkout, stripe-order-sync | No (defaults to the deployment's own origin) |
| `META_PIXEL_ID` | config, stripe-order-sync | No — Meta tracking skipped if unset |
| `META_CAPI_ACCESS_TOKEN` | stripe-order-sync | No |
| `TIKTOK_PIXEL_CODE` | config, stripe-order-sync | No — TikTok tracking skipped if unset |
| `TIKTOK_ACCESS_TOKEN` | stripe-order-sync | No |
| `GA4_MEASUREMENT_ID` | config, stripe-order-sync | No — GA4/Google tracking skipped if unset |
| `GA4_API_SECRET` | stripe-order-sync | No |
| `GOOGLE_ADS_CONVERSION_ID` | config | No (optional, e.g. `AW-123456789`) |

## KV namespace (for the admin order-alert feed)

1. `wrangler kv namespace create trendycatch-orders`
2. In the Cloudflare Pages dashboard → your project → Settings → Functions →
   KV namespace bindings → add binding name **`ORDERS_KV`** pointing at the
   namespace you just created.
3. (Optional, for local `wrangler pages dev`) paste the namespace id into
   `wrangler.toml`.

If `ORDERS_KV` isn't bound, the site still works end-to-end — orders still
sync to Shopify and pixels still fire — `admin.html` just won't show
anything, since that binding only feeds the live-order-sound dashboard.

## Deploying

No `CLOUDFLARE_API_TOKEN` is available in the environment this was built in,
so it can't be deployed directly from here. To connect it:

1. Push this repo to GitHub (already done, if you're reading this from the repo).
2. In the Cloudflare dashboard: **Workers & Pages → Create → Pages → Connect
   to Git** → pick `3DozPet/TrendyCatch-stripe-sync`.
3. Set **Build output directory** to `web` (root directory of this
   subproject) and leave the build command empty — this is a static site
   with Pages Functions, nothing to build.
4. Add the environment variables above under Settings → Environment
   variables (for both Production and Preview).
5. Add the KV namespace binding described above.
6. Set a custom domain of `trendycatch.us` under the project's Custom
   domains tab (point its DNS at Cloudflare if it isn't already).
7. In Stripe's dashboard, add a webhook endpoint pointing at
   `https://trendycatch.us/stripe-order-sync` listening for
   `checkout.session.completed`, and copy its signing secret into
   `STRIPE_WEBHOOK_SECRET`.

## Images

`products.json`'s `image` fields point at `/images/<id>.jpg`, which don't
exist yet — add the AI-polished product photos to a `web/images/` folder
with matching filenames before going live; until then the page shows a
simple 📦 placeholder for any image that fails to load.
