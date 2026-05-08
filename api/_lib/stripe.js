// Lightweight Stripe REST wrapper — no SDK dependency.
const STRIPE_API = 'https://api.stripe.com/v1'

function key() {
  const k = process.env.STRIPE_SECRET_KEY
  if (!k) throw new Error('STRIPE_SECRET_KEY not set')
  return k
}

function encode(obj, prefix) {
  const parts = []
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined || v === null) continue
    const p = prefix ? `${prefix}[${k}]` : k
    if (Array.isArray(v)) {
      v.forEach((item, i) => {
        if (typeof item === 'object') parts.push(encode(item, `${p}[${i}]`))
        else parts.push(`${encodeURIComponent(`${p}[${i}]`)}=${encodeURIComponent(item)}`)
      })
    } else if (typeof v === 'object') {
      parts.push(encode(v, p))
    } else {
      parts.push(`${encodeURIComponent(p)}=${encodeURIComponent(v)}`)
    }
  }
  return parts.join('&')
}

export async function call(method, path, body, opts = {}) {
  const url = `${STRIPE_API}${path}`
  const headers = {
    Authorization: `Bearer ${key()}`,
    'Content-Type': 'application/x-www-form-urlencoded',
  }
  if (opts.idempotencyKey) headers['Idempotency-Key'] = opts.idempotencyKey

  const resp = await fetch(url, {
    method,
    headers,
    body: body ? encode(body) : undefined,
  })
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`stripe ${resp.status}: ${data?.error?.message || text}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

export async function verifyWebhookSignature(rawBody, signatureHeader, secret) {
  if (!signatureHeader || !secret) return false
  const parts = Object.fromEntries(
    signatureHeader.split(',').map((p) => {
      const [k, ...v] = p.split('=')
      return [k, v.join('=')]
    })
  )
  const t = parts.t
  const v1 = parts.v1
  if (!t || !v1) return false
  const signedPayload = `${t}.${rawBody}`
  const enc = new TextEncoder()
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    enc.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  )
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(signedPayload))
  const expected = Array.from(new Uint8Array(sig))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
  if (expected.length !== v1.length) return false
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected.charCodeAt(i) ^ v1.charCodeAt(i)
  return diff === 0
}

export const createCheckoutSession    = (body, opts) => call('POST', '/checkout/sessions',    body, opts)
export const createBillingPortalSession = (body)     => call('POST', '/billing_portal/sessions', body)
export const retrieveSubscription     = (id)         => call('GET',  `/subscriptions/${id}`)
export const updateSubscription       = (id, body, opts) => call('POST', `/subscriptions/${id}`, body, opts)
export const retrieveCustomer         = (id)         => call('GET',  `/customers/${id}`)
export const createCustomer           = (body, opts) => call('POST', '/customers',             body, opts)
