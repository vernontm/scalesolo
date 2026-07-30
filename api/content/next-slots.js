// GET /api/content/next-slots?profile_id=<uuid>&count=5
//
// Returns the next K open posting slots for a brand's schedule, so a
// caller (the ScaleSolo MCP / a UI) can show "pick a time". Reuses
// findNextOpenSlot from the schedule grid (profile.posting_schedule)
// and treats already-scheduled rows as taken. Each returned slot is fed
// back into the taken-set so the list is K DISTINCT future openings.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { findNextOpenSlot } from '../_lib/scheduling.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET only' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const profileId = String(req.query.profile_id || '').trim()
    if (!profileId) return res.status(400).json({ error: 'profile_id required' })
    await assertProfileAccess(auth.user.id, profileId)

    const count = Math.max(1, Math.min(20, Number(req.query.count) || 5))

    const profileRows = await supaFetch(`profiles?id=eq.${profileId}&select=timezone,posting_schedule`)
    const profile = profileRows?.[0]
    if (!profile) return res.status(404).json({ error: 'profile not found' })

    const taken = await supaFetch(
      `content_scripts?profile_id=eq.${profileId}&status=eq.scheduled&select=scheduled_datetime`,
    ).catch(() => [])
    const takenIso = (taken || []).map((t) => t.scheduled_datetime).filter(Boolean)

    const tz = profile.timezone || 'America/Los_Angeles'
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz, weekday: 'short', month: 'short', day: 'numeric',
      hour: 'numeric', minute: '2-digit', hour12: true,
    })

    const slots = []
    const acc = [...takenIso]
    for (let i = 0; i < count; i++) {
      const iso = findNextOpenSlot(profile, acc)
      if (!iso) break               // schedule exhausted (no days/times, or 60d out)
      slots.push({ iso, local: fmt.format(new Date(iso)), timezone: tz })
      acc.push(iso)                 // so the next call skips this one
    }

    return res.status(200).json({ timezone: tz, slots })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
