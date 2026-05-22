// Thin wrapper around the Meta Pixel `fbq()` global. The base script
// is loaded synchronously from index.html before this module ever
// runs, so window.fbq exists by the time any UI calls these helpers.
//
// Every event we fire here also passes through to the server-side
// Conversions API (via api/stripe-webhook.js for Purchase, eventually
// via more dedupe endpoints). We share a single `eventID` between
// browser-side Pixel and server-side CAPI so Meta deduplicates the
// pair — without dedup we'd double-count every Purchase and waste
// optimization budget chasing a phantom 2x conversion rate.

const isBrowser = typeof window !== 'undefined'

// Cheap idempotent UUID for browser-side event_id. Real UUIDv4 would
// require a polyfill in some browsers; this gets us the same
// "vanishingly small collision probability" without one.
function eventId() {
  return (
    Date.now().toString(36) +
    Math.random().toString(36).slice(2, 10) +
    Math.random().toString(36).slice(2, 10)
  )
}

function trackBase(eventName, params = {}, options = {}) {
  if (!isBrowser || typeof window.fbq !== 'function') return null
  const id = options.eventID || eventId()
  try {
    window.fbq('track', eventName, params, { eventID: id })
  } catch (e) {
    // Pixel errors shouldn't crash the page. Log + swallow.
    if (typeof console !== 'undefined') console.warn('[pixel]', eventName, e?.message)
  }
  return id
}

// ── Public API ────────────────────────────────────────────────────────────

// Fired when a visitor lands on the /faceless-brand page (or any
// "viewed the offer" surface). The same event signals "saw the
// product" to Meta's algo.
export function trackViewContent(params = {}) {
  return trackBase('ViewContent', {
    content_name: 'Faceless Brand Trial',
    content_category: 'Subscription',
    content_type: 'product',
    currency: 'USD',
    value: 1.00,
    ...params,
  })
}

// Fired when the user clicks a "Start trial for $1" button on the
// landing page, BEFORE the redirect to Stripe Checkout. Captures
// intent even if the user bails at the Stripe form.
export function trackInitiateCheckout(params = {}) {
  return trackBase('InitiateCheckout', {
    content_name: 'Faceless Brand Trial',
    content_category: 'Subscription',
    currency: 'USD',
    value: 1.00,
    ...params,
  })
}

// Fired on the post-checkout page when Stripe has redirected back
// with a `stripe_session` query param. The eventID is the Stripe
// session id so the server-side CAPI Purchase (fired from
// stripe-webhook on checkout.session.completed) carries the same
// id and Meta dedupes the pair down to a single counted event.
export function trackPurchase(stripeSessionId, params = {}) {
  return trackBase(
    'Purchase',
    {
      content_name: 'Faceless Brand Trial',
      content_category: 'Subscription',
      currency: 'USD',
      value: 1.00,
      ...params,
    },
    { eventID: stripeSessionId || undefined }
  )
}

// Generic escape-hatch in case we want to fire a one-off custom
// event later (e.g. "AvatarCreated", "FirstVideoRendered") for
// retargeting audiences without adding a new helper each time.
export function trackCustom(eventName, params = {}, options = {}) {
  if (!isBrowser || typeof window.fbq !== 'function') return null
  const id = options.eventID || eventId()
  try {
    window.fbq('trackCustom', eventName, params, { eventID: id })
  } catch (e) {
    if (typeof console !== 'undefined') console.warn('[pixel:custom]', eventName, e?.message)
  }
  return id
}
