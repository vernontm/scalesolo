// POST /api/profiles/quickstart
// Body: { handle, platform, description }
//
// Day-one magic: the user pastes a social handle + a one-sentence
// description of what they post about, and Claude drafts a complete
// brand profile (bible, voice, target audience, core hashtags, threads
// style framework). They land on the Profiles page with a fully filled
// draft they can edit and save instead of staring at 20 empty fields.
//
// Why this matters: a half-filled brand profile produces generic
// content. Most users abandon during the cold-start. Claude can
// bootstrap a coherent draft from minimal input — the user just refines
// from there.
//
// Stub note: we don't actually scrape the social account. The handle
// gets recorded so the schedule_post node can use it later. Claude
// generates the brand from the description + general knowledge of the
// niche the handle implies (e.g., a TikTok handle named like a fitness
// coach gets a fitness-shaped voice, but the user always reviews).

import { setCors, requireUser, supaFetch } from '../_lib/supabase.js'
import { message } from '../_lib/anthropic.js'
import { indexBrandBible } from '../_lib/embeddings.js'

const SYSTEM = `You are a brand strategist drafting an initial brand profile for a content creator.
Output JSON ONLY (no markdown fences) with this exact shape:
{
  "business_name": "<the creator's brand name — derive from handle if not stated>",
  "owner_name": "<creator's first name if obvious from description, else null>",
  "industry": "<short industry tag e.g. 'fitness coaching', 'beauty', 'real estate'>",
  "preferred_tone": "<2-3 sentences describing the voice>",
  "target_audience": "<2-3 sentences on who they're for>",
  "brand_bible": "<400-800 word brand bible — voice/persona, what to write about, what to avoid, signature phrases, do/don't list>",
  "core_hashtags": "<5-8 hashtags space-separated, lowercase, no commas>",
  "threads_style": {
    "voice": "<one sentence>",
    "writing_style": "<one sentence>",
    "cta_style": "<one sentence>",
    "hashtag_rules": "<one sentence>",
    "core_topics": ["topic1", "topic2", "topic3"]
  }
}
Rules:
- NEVER use em dashes (—). Use commas, periods, or colons.
- The brand_bible must be specific enough that another writer could match the voice without seeing examples.
- Don't invent facts about the creator. Stick to voice/style based on the description.`

const PLATFORM_LABEL = {
  instagram: 'Instagram',
  tiktok:    'TikTok',
  youtube:   'YouTube',
  threads:   'Threads',
  x:         'X / Twitter',
  linkedin:  'LinkedIn',
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const { handle, platform = 'instagram', description } = req.body || {}
    if (!description || description.trim().length < 10) {
      return res.status(400).json({ error: 'A short description of what the brand posts about is required.' })
    }
    const cleanHandle = String(handle || '').trim().replace(/^@/, '').slice(0, 60)
    const platformKey = String(platform || 'instagram').toLowerCase()

    const userPrompt = `Handle: ${cleanHandle ? '@' + cleanHandle + ' on ' + (PLATFORM_LABEL[platformKey] || platformKey) : '(none provided)'}
What they post about: ${description.trim()}

Draft the brand profile JSON.`

    const resp = await message({
      system: SYSTEM,
      messages: [{ role: 'user', content: userPrompt }],
      max_tokens: 2400,
    })
    const raw = resp?.content?.[0]?.text || ''
    const jsonText = raw.replace(/^```json\s*|```$/g, '').trim()
    const parsed = (() => {
      try { return JSON.parse(jsonText) } catch {
        const m = jsonText.match(/\{[\s\S]*\}/)
        return m ? JSON.parse(m[0]) : null
      }
    })()
    if (!parsed) return res.status(502).json({ error: 'Could not parse the AI draft. Try again.' })

    // Stamp the social handle into the right column based on the chosen platform.
    const handleField = ({
      instagram: 'instagram_handle',
      tiktok:    'tiktok_handle',
      youtube:   'youtube_handle',
      threads:   'threads_handle',
      x:         'x_handle',
      linkedin:  'linkedin_handle',
    })[platformKey]

    const profileBody = {
      business_name:   parsed.business_name || cleanHandle || 'My brand',
      owner_name:      parsed.owner_name || null,
      industry:        parsed.industry || null,
      preferred_tone:  parsed.preferred_tone || null,
      target_audience: parsed.target_audience || null,
      brand_bible:     parsed.brand_bible || null,
      core_hashtags:   parsed.core_hashtags || null,
      threads_style:   parsed.threads_style || null,
      is_active:       true,
    }
    if (handleField && cleanHandle) profileBody[handleField] = cleanHandle

    const created = await supaFetch('profiles', { method: 'POST', body: profileBody })
    const profile = Array.isArray(created) ? created[0] : created
    if (!profile?.id) return res.status(500).json({ error: 'Profile insert failed' })

    await supaFetch('profile_access', {
      method: 'POST',
      body: {
        user_id: auth.user.id,
        profile_id: profile.id,
        role: 'owner',
        allowed_pages: ['*'],
      },
    })

    // Index the bible into the embeddings so script_gen can pull
    // semantic context from it on day one. Best-effort.
    try {
      if (profileBody.brand_bible) await indexBrandBible(profile.id, profileBody.brand_bible)
    } catch (e) { console.warn('quickstart: indexBrandBible failed', e.message) }

    return res.status(201).json({ profile, draft: parsed })
  } catch (err) {
    console.error('quickstart error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
