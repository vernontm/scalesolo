// POST /api/spaces/name-media  { url, filename? }
// Returns: { name } — a short, content-derived name for an uploaded image
// (e.g. "chicken shawarma plate" → used as the node's @-mention handle).
// Cheap vision call, not credit-gated. Falls back to the cleaned filename
// client-side if this errors, so failures here are non-fatal.

import { setCors, requireUser } from '../_lib/supabase.js'
import { message as anthropicMessage } from '../_lib/anthropic.js'

export const config = { maxDuration: 30 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    const { url } = req.body || {}
    if (!url) return res.status(400).json({ error: 'url required' })
    const out = await anthropicMessage({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: 20,
      system: 'Name what is in the image in 1 to 3 lowercase words (a subject label like "chicken shawarma" or "restaurant interior" or "logo"). Reply with ONLY the words, no punctuation.',
      messages: [{ role: 'user', content: [
        { type: 'image', source: { type: 'url', url } },
        { type: 'text', text: 'Name this.' },
      ] }],
    })
    const raw = (out?.content || []).map((c) => c?.text || '').join('').trim().toLowerCase()
    const name = raw.replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, ' ').trim().split(' ').slice(0, 3).join(' ')
    if (!name) return res.status(200).json({ name: null })
    return res.status(200).json({ name })
  } catch (err) {
    return res.status(200).json({ name: null })
  }
}
