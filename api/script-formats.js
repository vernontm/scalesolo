// /api/script-formats — read-only public catalog of generation formats.

import { setCors, requireUser, supaFetch } from './_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const rows = await supaFetch(
      `script_formats?active=eq.true&select=key,label,description,prompt_directive,sort_order&order=sort_order.asc`
    )
    return res.status(200).json({ formats: rows || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
