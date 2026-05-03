import { setCors, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).end()

  try {
    const rows = await supaFetch('founding_member_count?id=eq.1&select=claimed,cap')
    const row = rows?.[0] || { claimed: 0, cap: 100 }
    return res.status(200).json({
      claimed: row.claimed,
      cap: row.cap,
      remaining: Math.max(0, row.cap - row.claimed),
      sold_out: row.claimed >= row.cap,
    })
  } catch {
    return res.status(200).json({ claimed: 0, cap: 100, remaining: 100, sold_out: false })
  }
}
