// TEMP debug endpoint — reports which env vars are SET (no values).
// Delete after M1 wiring is verified.
import { setCors } from './_lib/supabase.js'

const REQUIRED = [
  'SUPABASE_URL',
  'SUPABASE_ANON_KEY',
  'SUPABASE_SERVICE_KEY',
  'ALLOWED_ORIGINS',
  'SCALESOLO_DOMAIN',
  'STRIPE_SECRET_KEY',
  'STRIPE_PUBLISHABLE_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'STRIPE_PRICE_FOUNDING',
  'STRIPE_PRICE_SOLO_STARTER',
  'STRIPE_PRICE_SOLO_STARTER_ANNUAL',
  'STRIPE_PRICE_SOLO_PRO',
  'STRIPE_PRICE_SOLO_PRO_ANNUAL',
  'STRIPE_PRICE_SOLO_STUDIO',
  'STRIPE_PRICE_SOLO_STUDIO_ANNUAL',
]

export default async function handler(req, res) {
  setCors(req, res)
  const status = {}
  for (const k of REQUIRED) {
    const v = process.env[k]
    status[k] = v ? `SET (${v.length} chars)` : 'MISSING'
  }
  return res.status(200).json({ env: status })
}
