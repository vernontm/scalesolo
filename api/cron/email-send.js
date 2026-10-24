// Cron, every minute: promote due scheduled campaigns to sending, then work
// through every campaign that is still sending. Each tick is bounded so the
// function never hits its timeout mid-send; the worker's claim-before-send
// rows guarantee a contact is never reached twice across ticks.
//
// Auth: CRON_SECRET bearer (Vercel adds it to cron invocations).

import { setCors, supaFetch } from '../_lib/supabase.js'
import { processCampaign } from '../_lib/email-send-worker.js'
import { isConfigured } from '../_lib/email-provider.js'

export const config = { maxDuration: 60 }

const TICK_BUDGET_MS = 50000

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  const bearer = (req.headers?.authorization || '').replace(/^Bearer\s+/i, '')
  const cronSecret = process.env.CRON_SECRET
  if (!cronSecret || !bearer || bearer !== cronSecret) return res.status(401).json({ error: 'Unauthorized' })
  if (!isConfigured()) return res.status(200).json({ ok: true, skipped: 'SES not configured' })

  const started = Date.now()
  const out = { promoted: 0, campaigns: [] }
  try {
    const now = new Date().toISOString()
    const due = await supaFetch(
      `email_campaigns?status=eq.scheduled&scheduled_at=lte.${encodeURIComponent(now)}&select=id`,
      { method: 'PATCH', body: { status: 'sending', started_at: now, updated_at: now } },
    )
    out.promoted = Array.isArray(due) ? due.length : 0

    const sending = await supaFetch('email_campaigns?status=eq.sending&select=id,subject&order=started_at.asc.nullsfirst&limit=20') || []
    for (let i = 0; i < sending.length; i++) {
      const remaining = TICK_BUDGET_MS - (Date.now() - started)
      if (remaining < 3000) break
      const share = Math.floor(remaining / (sending.length - i))
      const stats = await processCampaign(sending[i].id, { budgetMs: share })
      out.campaigns.push({ id: sending[i].id, ...stats })
    }
    return res.status(200).json({ ok: true, ...out, ms: Date.now() - started })
  } catch (e) {
    console.error('[cron/email-send]', e)
    return res.status(500).json({ error: e?.message || 'Internal error', ...out })
  }
}
