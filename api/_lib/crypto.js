// AES-256-GCM encryption for at-rest secrets (BYOK ElevenLabs API
// keys today; can store other tokens later). The encryption key is
// derived from process.env.ELEVENLABS_KEY_SECRET via SHA-256 so any
// strong-enough random string works as the env value.
//
// Output format: base64 of  [12-byte iv][16-byte authTag][ciphertext]
// — single self-describing string written to a single text column.
//
// Set ELEVENLABS_KEY_SECRET in Vercel:
//   openssl rand -hex 32     # then paste

import { createCipheriv, createDecipheriv, randomBytes, createHash } from 'node:crypto'

const ALGORITHM = 'aes-256-gcm'

function deriveKey() {
  const secret = process.env.ELEVENLABS_KEY_SECRET
  if (!secret || secret.length < 16) {
    throw new Error('ELEVENLABS_KEY_SECRET not set (or < 16 chars)')
  }
  // SHA-256 → 32 raw bytes, exactly what AES-256 wants.
  return createHash('sha256').update(secret).digest()
}

export function encryptSecret(plain) {
  if (!plain || typeof plain !== 'string') throw new Error('plain text required')
  const key = deriveKey()
  const iv = randomBytes(12)
  const cipher = createCipheriv(ALGORITHM, key, iv)
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  const tag = cipher.getAuthTag()
  return Buffer.concat([iv, tag, ct]).toString('base64')
}

export function decryptSecret(blob) {
  if (!blob || typeof blob !== 'string') throw new Error('encrypted blob required')
  const key = deriveKey()
  const buf = Buffer.from(blob, 'base64')
  if (buf.length < 12 + 16 + 1) throw new Error('encrypted blob too short')
  const iv  = buf.subarray(0, 12)
  const tag = buf.subarray(12, 28)
  const ct  = buf.subarray(28)
  const decipher = createDecipheriv(ALGORITHM, key, iv)
  decipher.setAuthTag(tag)
  const plain = Buffer.concat([decipher.update(ct), decipher.final()])
  return plain.toString('utf8')
}

// Mask helper for UI display — never expose the real value.
export function maskSecretLast4(plain) {
  const s = String(plain || '')
  return s.length >= 4 ? s.slice(-4) : ''
}
