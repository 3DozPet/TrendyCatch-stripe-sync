import { getStore } from "@netlify/blobs"

export const pureGlowOrigin = "https://pureglow-clearance.netlify.app"
export const attributionStore = () => getStore({ name: "pureglow-attribution", consistency: "strong" })

export type PureGlowAttribution = {
  ttclid?: string
  fbc?: string
  fbp?: string
  ip?: string
  userAgent?: string
  capturedAt: number
}

export async function readPureGlowAttribution(reference: string | null) {
  if (!reference || !/^pg_[0-9a-f]{32}$/.test(reference)) return undefined
  const record = await attributionStore().get(reference, { type: "json" }) as PureGlowAttribution | null
  if (record && Date.now() - record.capturedAt <= 7 * 24 * 60 * 60 * 1000) return record
}
