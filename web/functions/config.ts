// GET /config — public (non-secret) pixel/tag IDs, read from env so they can be
// changed without a redeploy. None of these values are secrets; they're the same
// IDs that end up visible in every page's client-side script anyway.
interface Env {
  META_PIXEL_ID?: string
  TIKTOK_PIXEL_CODE?: string
  GA4_MEASUREMENT_ID?: string // covers Google Ads + YouTube via linked conversions
  GOOGLE_ADS_CONVERSION_ID?: string // optional, e.g. "AW-123456789"
}

export const onRequestGet: PagesFunction<Env> = async ({ env }) => {
  return new Response(
    JSON.stringify({
      metaPixelId: env.META_PIXEL_ID ?? null,
      tiktokPixelCode: env.TIKTOK_PIXEL_CODE ?? null,
      ga4MeasurementId: env.GA4_MEASUREMENT_ID ?? null,
      googleAdsConversionId: env.GOOGLE_ADS_CONVERSION_ID ?? null,
    }),
    { headers: { "content-type": "application/json", "cache-control": "max-age=300" } },
  )
}
