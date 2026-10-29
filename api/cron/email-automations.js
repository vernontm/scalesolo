// Cron, every minute: enrol new arrivals into active automations and send
// whatever step is due.
//
// Kept separate from api/cron/email-send.js on purpose. Broadcasts are the
// thing a client watches go out and notices immediately; drips run unattended.
// If this one throws or eats its whole budget, scheduled campaigns must still
// be sent by their own tick.
//
// Auth: CRON_SECRET bearer (Vercel adds it to cron invocations).

import { setCors } from '../_lib/supabase.js'
import { runAutomations } from '../_lib/email-automation-runner.js'
import { isConfigured } from '../_lib/email-provider.js'

export const config = { maxDuration: 60 }

const TICK_BUDGET_MS = 50000

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !bearer || bearer !== cronSecret) return res.status(401).json({ error: 'Unauthorized' })
  if (!isConfigured()) return res.status(200).json({ ok: true, skipped: 'no email provider configured' })

  const started = Date.now()
  try {
    const totals = await runAutomations({ budgetMs: TICK_BUDGET_MS })
    if (totals.stopped === 'not-installed') {
      return res.status(200).json({ ok: true, skipped: 'migration 0082 has not been applied yet' })
    }
    return res.status(200).json({ ok: true, ...totals, ms: Date.now() - started })
  } catch (e) {
    console.error('[cron/email-automations]', e)
    return res.status(500).json({ error: e?.message || 'Internal error' })
  }
}
