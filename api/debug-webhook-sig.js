// TEMP — verifies whether STRIPE_WEBHOOK_SECRET in Vercel matches what we expect.
// Returns the SHA-256 of the secret (not the secret itself) and a sample HMAC.
// Delete after webhook is confirmed working.

export const config = { runtime: 'edge' }

export default async function handler(req) {
  const url = new URL(req.url)
  const secret = process.env.STRIPE_WEBHOOK_SECRET || ''
  const enc = new TextEncoder()

  // Hash the secret so we can compare without exposing it.
  const secretHashBuf = await crypto.subtle.digest('SHA-256', enc.encode(secret))
  const secretHash = Array.from(new Uint8Array(secretHashBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')

  // Sign a fixed test payload so we can compare against our local openssl output.
  const testPayload = '1700000000.{"test":true}'
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
  )
  const sigBuf = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(testPayload))
  const sigHex = Array.from(new Uint8Array(sigBuf)).map((b) => b.toString(16).padStart(2, '0')).join('')

  return new Response(JSON.stringify({
    secret_set: secret.length > 0,
    secret_length: secret.length,
    secret_first6: secret.slice(0, 6),
    secret_last4: secret.slice(-4),
    secret_sha256: secretHash,
    sample_hmac_for_payload: testPayload,
    sample_hmac_hex: sigHex,
  }), { status: 200, headers: { 'Content-Type': 'application/json' } })
}
