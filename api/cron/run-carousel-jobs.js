// Vercel cron — every minute. Safety net that re-kicks any carousel job that
// is unfinished and not currently claimed (its self-kick died, or it ran out
// of time-budget in a prior invocation). Also fails jobs stuck far too long.

import { setCors, supaFetch } from '../_lib/supabase.js'
import { kickCarouselJob } from '../_lib/carousel-kick.js'

export const config = { maxDuration: 60 }

const STALE_MS = 4 * 60_000
const DEAD_MS = 30 * 60_000

export default async function handler(req, res) {
  setCors(req, res)
  try {
    const staleIso = new Date(Date.now() - STALE_MS).toISOString()
    // Unfinished jobs whose claim is stale (or never claimed).
    const rows = await supaFetch(
      `carousel_jobs?status=in.(queued,working)&or=(claimed_at.is.null,claimed_at.lt.${encodeURIComponent(staleIso)})&order=updated_at.asc&limit=10&select=id,user_id,created_at`,
    )
    const jobs = Array.isArray(rows) ? rows : []
    let kicked = 0, failed = 0
    for (const j of jobs) {
      if (Date.now() - new Date(j.created_at).getTime() > DEAD_MS) {
        await supaFetch(`carousel_jobs?id=eq.${j.id}`, { method: 'PATCH', body: { status: 'failed', stage: 'Timed out', error: 'Generation took too long and was stopped.', updated_at: new Date().toISOString() } })
        failed++
        continue
      }
      await kickCarouselJob(j.id, j.user_id)
      kicked++
    }
    return res.status(200).json({ ok: true, kicked, failed })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
