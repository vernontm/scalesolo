// POST /api/content/topic-from-media
// Body: { profile_id, video_url?, image_url? }
// Returns: { topic, source: 'transcript' | 'vision' }
//
// Turns a piece of upstream media into a "topic" string the script_gen
// node can consume. Two paths:
//
//   VIDEO   → ElevenLabs Scribe transcript. Used as a verbatim topic so
//             script_gen rewrites a fresh on-brand script that lines up
//             with what the user actually said in the clip.
//
//   IMAGE   → Claude (vision-enabled) reads the image, picks out
//             foreground subject + tone + setting + any visible text,
//             and proposes a brand-aligned topic angle that script_gen
//             can build a script around.
//
// Used by the server-side AND browser-side script_gen runners when no
// explicit topic is wired (Upload media → script_gen). Keeps both paths
// thin: they call this endpoint instead of duplicating the prompt logic.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { transcribeFromUrl } from '../_lib/scribe.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'

export const config = { maxDuration: 300 }

export default async function handler(req, res) {
  setCors(res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST')     return res.status(405).json({ error: 'Method not allowed' })

  try {
    const auth = await requireUser(req)
    const { profile_id, video_url, image_url } = req.body || {}
    if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
    if (!video_url && !image_url) return res.status(400).json({ error: 'video_url or image_url required' })
    await assertProfileAccess(auth.user.id, profile_id)

    // VIDEO path — verbatim transcript via Scribe (with worker audio-
    // extract pre-step when WORKER_URL is set, so this works on big
    // .mov files that would otherwise blow Scribe's limits).
    if (video_url) {
      const result = await transcribeFromUrl(video_url, { no_verbatim: true, profile_id })
      const text = String(result?.text || '').trim()
      if (!text) return res.status(200).json({ topic: '', source: 'transcript', warning: 'empty transcript (video may have no audio)' })
      return res.status(200).json({ topic: text, source: 'transcript' })
    }

    // IMAGE path — Claude vision. Reads brand context first so the
    // proposed topic stays on-brand instead of a generic description.
    const brandCtx = await loadBrandContext(profile_id).catch(() => null)
    const brandMd  = brandCtx ? renderBrandContextMarkdown(brandCtx) : ''

    const prompt = `You're looking at an image a creator wants to post. Generate a SINGLE topic angle (one or two sentences) that:
- Identifies what's in the image (subject, setting, mood, any visible text or product)
- Frames it as a content angle that fits the brand voice + audience below
- Is concrete enough that a script writer can build a 30-90 second post around it
- NEVER uses em dashes (—). Use commas, periods, or colons instead.

Return ONLY the topic sentence(s), no preamble, no labels, no quotes.

<brand_context>
${brandMd || '(no brand context)'}
</brand_context>`

    const resp = await message({
      max_tokens: 400,
      system: 'You analyze images and propose on-brand content topics for short-form social posts.',
      messages: [{
        role: 'user',
        content: [
          { type: 'image', source: { type: 'url', url: image_url } },
          { type: 'text', text: prompt },
        ],
      }],
    })
    const topic = (resp?.content?.find?.((b) => b.type === 'text')?.text || '').trim()
    if (!topic) return res.status(502).json({ error: 'Vision call returned no topic' })

    return res.status(200).json({ topic, source: 'vision' })
  } catch (err) {
    console.error('topic-from-media error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
