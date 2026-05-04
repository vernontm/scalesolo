// PUBLIC analytics beacon. POST { page_id, scroll_depth_pct?, time_on_page_sec?, utm? }
import { setCors, supaFetch } from '../_lib/supabase.js'

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).end()

  try {
    const { page_id, scroll_depth_pct, time_on_page_sec, utm } = req.body || {}
    if (!page_id) return res.status(400).json({ error: 'page_id required' })
    const referrer = req.headers.referer || null
    const ua = req.headers['user-agent'] || null
    const ip = (req.headers['x-forwarded-for'] || '').split(',')[0].trim() || null

    await supaFetch('landing_page_views', {
      method: 'POST',
      prefer: 'return=minimal',
      body: {
        page_id,
        scroll_depth_pct: scroll_depth_pct ?? null,
        time_on_page_sec: time_on_page_sec ?? null,
        utm: utm || null,
        referrer,
        user_agent: ua,
        ip_address: ip,
      },
    })
    return res.status(200).json({ ok: true })
  } catch {
    // Public beacon; never error to the visitor
    return res.status(200).json({ ok: true })
  }
}
