// Posting-schedule slot finder + collection-status sync.
//
// findNextOpenSlot(profile, alreadyScheduledTimestamps) → ISO string in UTC
//   Walks forward day-by-day from "now in profile.timezone" through the
//   profile.posting_schedule.{days, times} grid and returns the first slot
//   not already taken. days are 0..6 (Sun..Sat); times are "HH:MM" strings.
//
// syncContentStatusInSpaces(profile_id, content_id, newStatus)
//   Patches every collection node in the profile's spaces.nodes JSON whose
//   items contain that content_id, updating each item's status field.

import { supaFetch } from './supabase.js'

// Format a JS Date in the given IANA timezone as components.
function partsInTz(date, tz) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false, weekday: 'short',
  })
  const parts = Object.fromEntries(fmt.formatToParts(date).map((p) => [p.type, p.value]))
  const dayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }
  return {
    y: Number(parts.year), m: Number(parts.month), d: Number(parts.day),
    h: Number(parts.hour === '24' ? '00' : parts.hour),
    min: Number(parts.minute),
    weekday: dayMap[parts.weekday] ?? 0,
  }
}

// Build a Date that represents the wall-clock time HH:MM on yyyy-mm-dd
// in the given timezone, returned as a UTC Date.
function tzWallClockToUtc(y, m, d, hh, mm, tz) {
  // Trick: format an arbitrary timestamp in the target tz and use the
  // offset to figure out what UTC time corresponds to the local wall clock.
  const ref = new Date(Date.UTC(y, m - 1, d, hh, mm))
  const refLocal = partsInTz(ref, tz)
  // refLocal is what (UTC midnight + hh:mm) shows as in tz. Compare to the
  // target (y, m, d, hh, mm) to get the offset shift in minutes.
  const desiredUtcGuess = Date.UTC(y, m - 1, d, hh, mm)
  const localShownAsUtc = Date.UTC(refLocal.y, refLocal.m - 1, refLocal.d, refLocal.h, refLocal.min)
  const offsetMs = desiredUtcGuess - localShownAsUtc
  return new Date(desiredUtcGuess + offsetMs)
}

export function findNextOpenSlot(profile, alreadyScheduledIsoStrings = []) {
  const tz = profile?.timezone || 'America/Los_Angeles'
  const sched = profile?.posting_schedule || {}
  const days = Array.isArray(sched.days) ? sched.days : [1, 2, 3, 4, 5]
  const times = Array.isArray(sched.times) && sched.times.length ? sched.times : ['09:00']
  if (!days.length || !times.length) return null

  const taken = new Set(
    alreadyScheduledIsoStrings.filter(Boolean).map((s) => new Date(s).toISOString())
  )

  // Walk up to 60 days forward looking for the first valid + free slot.
  const now = new Date()
  for (let offset = 0; offset < 60; offset++) {
    const probeDate = new Date(now.getTime() + offset * 86400000)
    const local = partsInTz(probeDate, tz)
    if (!days.includes(local.weekday)) continue
    for (const t of times) {
      const [hhStr, mmStr] = String(t).split(':')
      const hh = Number(hhStr); const mm = Number(mmStr)
      const slotUtc = tzWallClockToUtc(local.y, local.m, local.d, hh, mm, tz)
      // Skip slots in the past (with 1-minute fudge)
      if (slotUtc.getTime() <= now.getTime() + 60_000) continue
      const iso = slotUtc.toISOString()
      if (taken.has(iso)) continue
      return iso
    }
  }
  return null
}

// Walk every space row for this profile and update collection-node items
// matching the content_id. Best-effort; doesn't throw on per-space errors.
export async function syncContentStatusInSpaces(profile_id, content_id, newStatus) {
  if (!profile_id || !content_id) return { updated: 0 }
  let updated = 0
  try {
    const spaces = await supaFetch(`spaces?profile_id=eq.${profile_id}&select=id,nodes`)
    for (const sp of spaces || []) {
      let dirty = false
      const nextNodes = (sp.nodes || []).map((n) => {
        if (n?.data?.type !== 'collection') return n
        const items = Array.isArray(n.data?.output?.items) ? n.data.output.items : []
        if (!items.length) return n
        const newItems = items.map((it) => {
          if (it?.content_id === content_id && it?.status !== newStatus) {
            dirty = true
            return { ...it, status: newStatus }
          }
          return it
        })
        if (newItems === items) return n
        return { ...n, data: { ...n.data, output: { ...n.data.output, items: newItems } } }
      })
      if (dirty) {
        await supaFetch(`spaces?id=eq.${sp.id}`, {
          method: 'PATCH',
          body: { nodes: nextNodes },
        })
        updated++
      }
    }
  } catch (e) {
    console.warn('syncContentStatusInSpaces failed:', e.message)
  }
  return { updated }
}
