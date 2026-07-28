// Deterministic holiday / observance calculator for the campaign
// planner. No external API — a rule-computed set of US federal holidays
// plus a curated list of marketing- and food-relevant observances that
// make good post hooks (Valentine's, Mother's/Father's Day, national
// food days, etc.). Islamic holidays (relevant to halal clients like
// Sanabreh) are lunar and can't be computed by simple rules, so a small
// lookup table covers the near-term years.
//
// Usage:
//   import { holidaysInWindow } from '../_lib/holidays.js'
//   holidaysInWindow('2026-08-01', 30, 'US')
//     → [{ date: '2026-08-10', name: 'National S'mores Day', kind: 'food' }, ...]
//
// kind ∈ 'federal' | 'marketing' | 'food' | 'religious' — lets the
// planner weight how heavily to lean on each (a promo around a food day
// vs a respectful nod to a religious observance).

// ── nth-weekday helper ──────────────────────────────────────────────
// weekday: 0=Sun..6=Sat. n: 1..5 for "nth", or -1 for "last".
function nthWeekday(year, monthIdx, weekday, n) {
  if (n === -1) {
    const last = new Date(Date.UTC(year, monthIdx + 1, 0))
    const shift = (last.getUTCDay() - weekday + 7) % 7
    return new Date(Date.UTC(year, monthIdx + 1, 0 - shift))
  }
  const first = new Date(Date.UTC(year, monthIdx, 1))
  const shift = (weekday - first.getUTCDay() + 7) % 7
  return new Date(Date.UTC(year, monthIdx, 1 + shift + (n - 1) * 7))
}

const iso = (d) => d.toISOString().slice(0, 10)
const fixed = (year, monthIdx, day) => iso(new Date(Date.UTC(year, monthIdx, day)))

// US federal + widely-marketed holidays for a given year.
function usHolidays(year) {
  return [
    { date: fixed(year, 0, 1),   name: "New Year's Day",        kind: 'federal' },
    { date: iso(nthWeekday(year, 0, 1, 3)),  name: 'Martin Luther King Jr. Day', kind: 'federal' },
    { date: fixed(year, 1, 2),   name: 'Groundhog Day',         kind: 'marketing' },
    { date: fixed(year, 1, 14),  name: "Valentine's Day",       kind: 'marketing' },
    { date: iso(nthWeekday(year, 1, 1, 3)),  name: "Presidents' Day", kind: 'federal' },
    { date: fixed(year, 2, 17),  name: "St. Patrick's Day",     kind: 'marketing' },
    { date: fixed(year, 3, 22),  name: 'Earth Day',             kind: 'marketing' },
    { date: fixed(year, 4, 5),   name: 'Cinco de Mayo',         kind: 'marketing' },
    { date: iso(nthWeekday(year, 4, 0, 2)),  name: "Mother's Day", kind: 'marketing' },
    { date: iso(nthWeekday(year, 4, 1, -1)), name: 'Memorial Day', kind: 'federal' },
    { date: fixed(year, 5, 19),  name: 'Juneteenth',            kind: 'federal' },
    { date: iso(nthWeekday(year, 5, 0, 3)),  name: "Father's Day", kind: 'marketing' },
    { date: fixed(year, 6, 4),   name: 'Independence Day',       kind: 'federal' },
    { date: iso(nthWeekday(year, 8, 1, 1)),  name: 'Labor Day',  kind: 'federal' },
    { date: fixed(year, 9, 31),  name: 'Halloween',             kind: 'marketing' },
    { date: iso(nthWeekday(year, 10, 4, 4)), name: 'Thanksgiving', kind: 'federal' },
    { date: iso(new Date(Date.UTC(year, 10, nthWeekday(year, 10, 4, 4).getUTCDate() + 1))), name: 'Black Friday', kind: 'marketing' },
    { date: fixed(year, 11, 24), name: 'Christmas Eve',          kind: 'marketing' },
    { date: fixed(year, 11, 25), name: 'Christmas Day',          kind: 'federal' },
    { date: fixed(year, 11, 31), name: "New Year's Eve",         kind: 'marketing' },
  ]
}

// Curated food/observance days that make strong restaurant + product
// post hooks. Month is 0-indexed. Keep this focused on days a small
// business would actually market around.
const FOOD_DAYS = [
  { m: 0, d: 24, name: 'National Compliment Day', kind: 'marketing' },
  { m: 1, d: 9,  name: 'National Pizza Day', kind: 'food' },
  { m: 2, d: 20, name: 'National Ravioli Day', kind: 'food' },
  { m: 4, d: 13, name: 'National Hummus Day', kind: 'food' },
  { m: 4, d: 28, name: 'National Burger Day', kind: 'food' },
  { m: 5, d: 3,  name: 'National Falafel Day', kind: 'food' },
  { m: 6, d: 6,  name: 'National Fried Chicken Day', kind: 'food' },
  { m: 7, d: 10, name: "National S'mores Day", kind: 'food' },
  { m: 7, d: 24, name: 'National Waffle Day', kind: 'food' },
  { m: 8, d: 5,  name: 'National Cheese Pizza Day', kind: 'food' },
  { m: 9, d: 4,  name: 'National Taco Day', kind: 'food' },
  { m: 10, d: 3, name: 'National Sandwich Day', kind: 'food' },
]

// Islamic holidays are lunar; hardcode near-term Gregorian dates
// (approximate — actual start depends on moon sighting). Relevant to
// halal clients. Extend as years are added.
const ISLAMIC = [
  { date: '2026-02-18', name: 'Ramadan begins', kind: 'religious' },
  { date: '2026-03-20', name: 'Eid al-Fitr', kind: 'religious' },
  { date: '2026-05-27', name: 'Eid al-Adha', kind: 'religious' },
  { date: '2027-02-08', name: 'Ramadan begins', kind: 'religious' },
  { date: '2027-03-10', name: 'Eid al-Fitr', kind: 'religious' },
  { date: '2027-05-17', name: 'Eid al-Adha', kind: 'religious' },
]

// Return all observances whose date falls within [startISO, startISO+days).
// region is accepted for forward-compatibility; only 'US' is populated today.
export function holidaysInWindow(startISO, days, region = 'US') {
  const start = new Date(`${String(startISO).slice(0, 10)}T00:00:00Z`)
  if (Number.isNaN(start.getTime())) return []
  const n = Math.max(1, Math.min(366, Number(days) || 1))
  const end = new Date(start.getTime() + n * 86400000)
  const startD = iso(start)
  const endD = iso(end)

  const years = new Set([start.getUTCFullYear(), end.getUTCFullYear()])
  const pool = []
  for (const y of years) {
    pool.push(...usHolidays(y))
    for (const f of FOOD_DAYS) pool.push({ date: fixed(y, f.m, f.d), name: f.name, kind: f.kind })
  }
  pool.push(...ISLAMIC)

  return pool
    .filter((h) => h.date >= startD && h.date < endD)
    .sort((a, b) => a.date.localeCompare(b.date))
    // De-dupe same-day/same-name collisions across the year boundary.
    .filter((h, i, arr) => i === 0 || h.date !== arr[i - 1].date || h.name !== arr[i - 1].name)
}
