// Server-side Meta Conversions API helper. Fires events to:
//   POST https://graph.facebook.com/v18.0/{PIXEL_ID}/events
//
// Mirrors the browser-side Pixel events fired from src/lib/meta-pixel.js
// so Meta sees the same conversion from two channels. Both events
// must carry an identical `event_id` so Meta dedupes them down to a
// single counted conversion — we use the Stripe checkout-session id
// because it's globally unique per checkout and available on both
// the browser (in the success URL) and the server (in the webhook).
//
// PII matching parameters (email, names, address) are SHA-256 hashed
// per Meta's requirement before transmission. The hash is lowercase
// hex of the lowercased + trimmed value. IP, user agent, click id
// (fbc), and browser id (fbp) are NOT hashed — Meta expects them
// raw.
//
// Required Vercel env:
//   META_PIXEL_ID    — 1865831664085007 (defaults to that if unset)
//   META_CAPI_TOKEN  — long-lived access token from Events Manager
//                      → Settings → Conversions API → Generate Token
//
// Optional Vercel env:
//   META_CAPI_TEST_EVENT_CODE — if set, events are routed into the
//      Test Events panel only (not live ads attribution). Use for
//      verifying the wiring before going to prod.

const META_GRAPH_VERSION = 'v18.0'
const DEFAULT_PIXEL_ID   = '1865831664085007'

// Lowercase + trim + SHA-256 hash, hex-encoded. Meta requires this
// exact pipeline for all PII matching parameters. Empty / null inputs
// return null so we don't ship "da39a3ee5e6b4b0d…" (the empty-string
// hash) to Meta and corrupt our match rate.
//
// Uses Web Crypto (globalThis.crypto.subtle) so this module runs on
// Vercel Edge Runtime (stripe-webhook) AND classic Node Functions
// without conditional imports.
async function hashPII(input) {
  if (input == null) return null
  const s = String(input).trim().toLowerCase()
  if (!s) return null
  const data = new TextEncoder().encode(s)
  const buf  = await globalThis.crypto.subtle.digest('SHA-256', data)
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// Build the user_data block per Meta CAPI spec. Anything we don't
// have is simply omitted — partial data is fine, empty data is not.
async function buildUserData({ email, firstName, lastName, city, state, zip, country, externalId, clientIp, userAgent, fbc, fbp }) {
  const ud = {}
  const [em, fn, ln, ct, st, zp, co, xid] = await Promise.all([
    hashPII(email),
    hashPII(firstName),
    hashPII(lastName),
    hashPII(city),
    hashPII(state),
    hashPII(zip),
    country ? hashPII(String(country).slice(0, 2)) : null,
    hashPII(externalId),
  ])
  if (em)  ud.em  = [em]
  if (fn)  ud.fn  = [fn]
  if (ln)  ud.ln  = [ln]
  if (ct)  ud.ct  = [ct]
  if (st)  ud.st  = [st]
  if (zp)  ud.zp  = [zp]
  if (co)  ud.country = [co]
  if (xid) ud.external_id = [xid]

  // IP, user-agent, fbc, fbp are sent RAW (not hashed).
  if (clientIp)  ud.client_ip_address = clientIp
  if (userAgent) ud.client_user_agent = userAgent
  if (fbc)       ud.fbc = fbc
  if (fbp)       ud.fbp = fbp
  return ud
}

// Send a single event. Returns { ok, status, response, error? } —
// never throws. Callers (stripe-webhook etc) treat this as fire-and-
// forget analytics; a CAPI failure must not break the Stripe response.
export async function sendCAPIEvent({
  eventName,
  eventId,
  eventTime,
  eventSourceUrl,
  actionSource = 'website',
  customData = {},
  userData = {},
}) {
  const pixelId = process.env.META_PIXEL_ID || DEFAULT_PIXEL_ID
  const token   = process.env.META_CAPI_TOKEN
  if (!token) {
    return { ok: false, status: 0, error: 'META_CAPI_TOKEN not configured' }
  }

  const body = {
    data: [{
      event_name: eventName,
      event_time: Math.floor((eventTime || Date.now()) / 1000),
      ...(eventId        ? { event_id: eventId } : {}),
      ...(eventSourceUrl ? { event_source_url: eventSourceUrl } : {}),
      action_source: actionSource,
      user_data: await buildUserData(userData),
      custom_data: customData,
    }],
  }
  // Test Events code goes at the TOP LEVEL of the request body, not
  // inside data[]. Setting this routes events to the Test Events
  // panel only, no production attribution. Useful when verifying the
  // wiring without polluting real ad performance data.
  if (process.env.META_CAPI_TEST_EVENT_CODE) {
    body.test_event_code = process.env.META_CAPI_TEST_EVENT_CODE
  }

  const url = `https://graph.facebook.com/${META_GRAPH_VERSION}/${pixelId}/events?access_token=${encodeURIComponent(token)}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await r.text()
    let parsed = null
    try { parsed = JSON.parse(text) } catch { parsed = { raw: text } }
    if (!r.ok) {
      console.warn(`[meta-capi] ${eventName} returned ${r.status}:`, parsed?.error?.message || text.slice(0, 200))
      return { ok: false, status: r.status, response: parsed }
    }
    return { ok: true, status: r.status, response: parsed }
  } catch (err) {
    console.warn(`[meta-capi] ${eventName} threw:`, err?.message || err)
    return { ok: false, status: 0, error: err?.message || String(err) }
  }
}

// Convenience wrapper for the Purchase event specifically. Sets the
// content_name + currency + value defaults that match what the
// browser-side trackPurchase() in src/lib/meta-pixel.js sends, so
// the dedup pair matches cleanly on more than just event_id.
export async function sendCAPIPurchase({
  eventId,           // REQUIRED — must match browser-side fbq Purchase event
  value = 1.00,
  currency = 'USD',
  contentName = 'Faceless Brand Trial',
  eventSourceUrl,
  user,              // { email, firstName, lastName, city, state, zip, country, externalId, clientIp, userAgent, fbc, fbp }
}) {
  return sendCAPIEvent({
    eventName: 'Purchase',
    eventId,
    eventSourceUrl,
    actionSource: 'website',
    customData: {
      currency,
      value,
      content_name: contentName,
      content_category: 'Subscription',
      content_type: 'product',
    },
    userData: user || {},
  })
}
