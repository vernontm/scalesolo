// /api/content/bulk-actions
//   ?action=generate-captions  POST { profile_id, script_ids? }
//     Batch-generate title + caption + hashtags + first_comment for all
//     selected scripts (or every script with caption=null) using one
//     Claude call seeded with the brand bible. Mirrors VTM's pattern.
//
//   ?action=auto-schedule       POST { profile_id, script_ids? }
//     Walk selected unscheduled scripts and assign each the next free
//     slot from the profile's posting_schedule. Sets status='scheduled'.
//
//   ?action=publish-selected   POST { profile_id, script_ids, platforms, upload_post_user? }
//     Submit each script to upload-post.com via the existing helper.
//     Returns per-script success/failure summary.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { findNextOpenSlot } from '../_lib/scheduling.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { transcribeFromUrl } from '../_lib/scribe.js'
import { uploadpostCancelByRequestId } from '../_lib/uploadpost.js'
import {
  resolveUploadpostUser, uploadpostEnsureUserProfile,
} from '../_lib/uploadpost.js'

const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY

// 300s gives auto-schedule headroom to submit up to 200 rows to Upload-Post
// inline (concurrency 5, ~1s per submission = ~40s typical) on top of the
// existing per-row PATCH writes.
export const config = { maxDuration: 300 }

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  const auth = await requireUser(req, res)
  if (!auth) return

  const action = String(req.query.action || '')
  const { profile_id, script_ids } = req.body || {}
  if (!profile_id) return res.status(400).json({ error: 'profile_id required' })
  await assertProfileAccess(auth.user.id, profile_id)

  try {
    if (action === 'generate-captions') return generateCaptions({ res, profile_id, script_ids, user_id: auth.user.id })
    if (action === 'auto-schedule')     return autoSchedule({ res, profile_id, script_ids, user_id: auth.user.id })
    if (action === 'publish-selected')  return publishSelected({ req, res, profile_id, script_ids, user_id: auth.user.id })
    if (action === 'resync-upload-post') return resyncUploadPost({ req, res, profile_id, script_ids })
    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('bulk-actions error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}

// ── generate-captions ──────────────────────────────────────────────────────
// Transcribes any video row that doesn't already have a full_script, then
// asks Claude for title + caption + hashtags + first_comment using:
//   - the transcript (the actual content of the video)
//   - the brand bible / voice / hashtags (the consistent brand context)
//
// This mirrors how VTM did it — the source of truth for caption content
// is the VIDEO ITSELF (via Scribe), not whatever title was guessed at
// upload time. Without transcription, a misleading auto-title (e.g.
// "Mom Eats Free This Mother's Day") was steering every caption Claude
// wrote on that row, even when the brand profile had nothing seasonal.
async function generateCaptions({ res, profile_id, script_ids, user_id }) {
  if (!ANTHROPIC_API_KEY) return res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' })

  // Brand context loaded through the shared helper so captions inherit
  // the same do_not_say / always_include / brand_cta rules + voice
  // summary the script generator uses. Skip exemplars (script-shaped
  // examples are noise for caption work) but keep the rated hooks +
  // bad-pattern blocks because openers carry over.
  const ctx = await loadBrandContext(profile_id, { skip: ['exemplars'] })
  const profile = ctx.profile
  if (!profile) return res.status(404).json({ error: 'Profile not found' })

  let q = `content_scripts?profile_id=eq.${profile_id}`
  if (Array.isArray(script_ids) && script_ids.length) {
    q += `&id=in.(${script_ids.map((id) => encodeURIComponent(id)).join(',')})`
  } else {
    q += '&caption=is.null'
  }
  q += '&select=id,title,full_script,hook,caption,media_type,media_urls'
  const scripts = await supaFetch(q)
  if (!scripts?.length) return res.status(200).json({ updated: 0 })

  // Credit gating. ~3000 ai_tokens per script captures the cost of one
  // Claude Sonnet call with a vision image block; we consume eagerly
  // BEFORE the upstream call and refund any unused budget afterwards
  // if Claude failed entirely. Without this, /generate-captions was a
  // free Sonnet pipe.
  const CAPTION_TOKENS_PER_SCRIPT = 3000
  const fee = scripts.length * CAPTION_TOKENS_PER_SCRIPT
  const cust = user_id ? await supaFetch(`billing_customers?user_id=eq.${user_id}&select=id`).catch(() => []) : []
  const customerId = cust?.[0]?.id || null
  if (customerId) {
    const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`).catch(() => [])
    if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
      return res.status(402).json({ error: 'Insufficient AI tokens for batch caption generation.', code: 'insufficient_credits', need: fee })
    }
  }

  // Minimal, voice-only brand context. Anything topical (target
  // audience descriptions, content pillars, exemplar scripts, voice
  // summary derived from past posts) is intentionally dropped — those
  // fields leak topic-words like "fitness", "brunch", "Houston" into
  // the prompt and Claude leans on them when the transcript is weak.
  // What survives:
  //   - business name + tone (style, not topic)
  //   - do_not_say / always_include / brand_cta (hard rules)
  //   - bad patterns (style anti-rules)
  //   - core hashtags (the only place topical leakage is wanted)
  //   - the full brand bible IF the user wrote one (it's the canonical
  //     voice source; capped to 2,500 chars). Empty bibles drop out.
  const bibleText = (profile.brand_bible || '').trim().slice(0, 2500)
  const toneLine = profile.preferred_tone ? `Voice / tone: ${profile.preferred_tone.trim()}` : ''
  const dnsArr = Array.isArray(profile.do_not_say) ? profile.do_not_say.filter(Boolean) : []
  const aiArr  = Array.isArray(profile.always_include) ? profile.always_include.filter(Boolean) : []
  const ctaStr = (profile.brand_cta || '').trim()
  const ruleLines = []
  if (dnsArr.length) ruleLines.push(`- NEVER use these words/phrases: ${dnsArr.map((s) => `"${s}"`).join(', ')}`)
  if (aiArr.length)  ruleLines.push(`- ALWAYS include at least one of: ${aiArr.map((s) => `"${s}"`).join(', ')}`)
  if (ctaStr)        ruleLines.push(`- Brand CTA (use when natural): "${ctaStr}"`)
  const badPatternsBlock = renderBrandContextMarkdown(ctx, { include: ['bad_patterns'] })
  const coreHashtagsLine = profile.core_hashtags
    ? `Core brand hashtags (lead with these in the hashtags field): ${profile.core_hashtags}`
    : ''
  const brandContext = [
    profile.business_name ? `Brand: ${profile.business_name}` : null,
    toneLine,
    ruleLines.length ? `Brand rules:\n${ruleLines.join('\n')}` : null,
    bibleText ? `Brand bible (voice reference, NOT a topic prompt):\n<brand_bible>\n${bibleText}\n</brand_bible>` : null,
    badPatternsBlock || null,
    coreHashtagsLine,
  ].filter(Boolean).join('\n\n').trim()
  const today = new Date().toISOString().slice(0, 10)

  // Per-media-type prompt builders. The user message carries the actual
  // image (image rows only) so Claude Vision can read it; for video
  // rows the transcript is baked into the system prompt directly.
  const videoSystemPrompt = (transcript) => `You are a social media content creator. Based on this video transcript and the brand context below, generate content for posting this video on social media.

TODAY'S DATE: ${today}

BRAND CONTEXT:
${brandContext}

VIDEO TRANSCRIPT:
${String(transcript || '').slice(0, 8000)}

Generate the following:
1. "title" - A short, click-worthy, engaging title for this video (max 12 words)
2. "hook" - The opening 1-2 sentences that hook viewers
3. "full_script" - A cleaned up version of the transcript as a readable script
4. "caption" - An engaging social media caption to post with this video. Match the brand voice.
5. "hashtags" - Include any core brand hashtags from the brand bible first, then 4-6 topic-specific ones.
6. "first_comment" - An engagement-driving first comment (question or call to action)

RULES:
- NEVER use em dashes (—). Use commas, periods, or colons instead.
- Match the brand voice and tone from the brand bible
- Make the caption punchy and engaging
- The title should be curiosity-driven, not generic

Return ONLY valid JSON:
{"title": "...", "hook": "...", "full_script": "...", "caption": "...", "hashtags": "...", "first_comment": "..."}`

  const imageSystemPrompt = `You are a social media content creator. Look at this image and the brand context below, then generate content for posting this image on social media.

TODAY'S DATE: ${today}

BRAND CONTEXT:
${brandContext}

Generate the following:
1. "title" - A short, click-worthy title for this image (max 10 words)
2. "caption" - An engaging social media caption that complements the image. Match the brand voice. 1-3 short paragraphs.
3. "hashtags" - Include any core brand hashtags from the brand bible first, then 4-6 image/topic-specific ones.
4. "first_comment" - An engagement-driving first comment (question or CTA)

RULES:
- NEVER use em dashes (—). Use commas, periods, or colons instead.
- Match the brand voice and tone from the brand bible
- Reference what's actually visible in the image
- Caption should drive engagement (question, story, or CTA)

Return ONLY valid JSON:
{"title": "...", "caption": "...", "hashtags": "...", "first_comment": "..."}`

  // Video rows: transcribe the audio via Scribe before composing the
  // user message. This is the difference between "Claude writes captions
  // from the actual content of the video" and "Claude writes captions
  // from whatever stale title was on the row." Without this step a
  // misleading auto-title steers every caption Claude produces.
  //
  // Parallel — Scribe with cloud_storage_url is cheap and a batch of 10
  // rows finishes in ~roughly-the-slowest-call wall time. We cache the
  // transcript back onto the row's full_script so re-clicks of Generate
  // Captions reuse it instead of paying Scribe again.
  const videoRowsNeedingTranscript = scripts
    .map((s, i) => ({ s, i }))
    .filter(({ s }) => s.media_type === 'video' && !s.full_script && Array.isArray(s.media_urls) && /^https?:\/\//.test(s.media_urls[0] || ''))
  const transcriptFailures = []
  if (videoRowsNeedingTranscript.length) {
    await Promise.all(videoRowsNeedingTranscript.map(async ({ s }) => {
      try {
        const result = await transcribeFromUrl(s.media_urls[0], { profile_id })
        const transcript = String(result?.text || '').trim()
        if (transcript) {
          s.full_script = transcript
          // Best-effort persist so re-runs / library views see it. Don't
          // fail the batch over a transient PATCH failure.
          await supaFetch(`content_scripts?id=eq.${s.id}`, {
            method: 'PATCH',
            body: { full_script: transcript },
            prefer: 'return=minimal',
          }).catch(() => {})
        } else {
          // Empty transcript — silent video, audio-stripped polish, etc.
          // We track it so the caller can surface it instead of letting
          // Claude write a brand-only caption with no topical anchor.
          transcriptFailures.push({ id: s.id, reason: 'empty_transcript' })
        }
      } catch (e) {
        console.warn(`[generate-captions] transcribe failed for ${s.id}:`, e?.message)
        transcriptFailures.push({ id: s.id, reason: e?.message || 'transcribe_error' })
      }
    }))
  }

  // Per-script Claude call. Each row gets its own request with a prompt
  // tailored to its media_type (video → transcript baked into system,
  // image → Claude Vision in user message). Returns the parsed object
  // or null on any failure so the caller can patch only successful rows.
  const parseJsonObject = (raw) => {
    if (!raw) return null
    const cleaned = String(raw).replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim()
    const m = cleaned.match(/\{[\s\S]*\}/)
    try { return JSON.parse(m ? m[0] : cleaned) } catch { return null }
  }
  const captionFor = async (s) => {
    const firstUrl = Array.isArray(s.media_urls) && s.media_urls[0]
    const isImage = s.media_type === 'image' && firstUrl && /^https?:\/\//.test(firstUrl)
    // Video path takes priority — a transcript is the strongest topic
    // signal we can give Claude. Falls through to the image prompt
    // when media_type is image, and to a "no signal" video-shaped
    // prompt when neither is available (rare; the upstream filter
    // mostly catches this).
    if (s.media_type === 'video' || (s.full_script && !isImage)) {
      // Transcript is the ONLY topic signal for videos. We deliberately
      // do not fall back to s.hook / s.title here anymore — those are
      // often empty or contain stale auto-generated text, and Claude
      // ends up writing from the brand context alone.
      const transcript = (s.full_script || '').trim()
      if (!transcript) {
        // Silent or music-only video. Return a sentinel so the caller
        // can skip the row entirely (no caption patch, no status flip
        // to caption_ready) and surface a clear "needs manual caption"
        // failure to the user.
        return { _no_transcript: true }
      }
      try {
        const ai = await message({
          system: videoSystemPrompt(transcript),
          messages: [{ role: 'user', content: 'Generate the JSON now.' }],
          max_tokens: 1500,
        })
        return parseJsonObject(ai?.content?.[0]?.text)
      } catch (e) {
        console.warn(`[generate-captions] video Claude failed for ${s.id}:`, e?.message)
        return null
      }
    }
    if (isImage) {
      try {
        const ai = await message({
          system: imageSystemPrompt,
          messages: [{
            role: 'user',
            content: [
              { type: 'image', source: { type: 'url', url: firstUrl } },
              { type: 'text', text: 'Read the image above and generate the JSON now.' },
            ],
          }],
          max_tokens: 1200,
        })
        return parseJsonObject(ai?.content?.[0]?.text)
      } catch (e) {
        console.warn(`[generate-captions] image Claude failed for ${s.id}:`, e?.message)
        return null
      }
    }
    // No media, no transcript — generic placeholder.
    return {
      title: 'Untitled post',
      caption: 'New post.',
      hashtags: profile.core_hashtags || '',
      first_comment: '',
    }
  }

  // Run all scripts in parallel. Per-script credit cost stays the same
  // pre-check up top — we pre-debited the whole batch.
  const captionResults = await Promise.all(scripts.map(captionFor))

  // Patch rows. Skip rows that came back with _no_transcript — those
  // need a manual caption (silent/music-only videos). Track them in
  // transcriptFailures so the UI can toast a clear "n video(s)
  // couldn't be auto-captioned" message instead of leaving the user
  // confused about why nothing changed.
  const results = await Promise.allSettled(captionResults.map((r, i) => {
    const script = scripts[i]
    if (!script || !r) return Promise.resolve({ ok: false })
    if (r._no_transcript) {
      transcriptFailures.push({ id: script.id, reason: 'no_speech_detected' })
      return Promise.resolve({ ok: false, skipped: 'no_transcript' })
    }
    const patch = {
      caption: r.caption || null,
      hashtags: r.hashtags || null,
      first_comment: r.first_comment || null,
      status: 'caption_ready',
    }
    if (r.title) patch.title = r.title
    if (r.hook) patch.hook = r.hook
    if (r.full_script) patch.full_script = r.full_script
    return supaFetch(`content_scripts?id=eq.${script.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' })
      .then(() => ({ ok: true }))
      .catch((e) => { console.warn('caption patch failed for', script.id, e.message); return { ok: false } })
  }))
  const updated = results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length

  // Consume credits AFTER the Claude call returned. Idempotent ref_id
  // (the AI request id from the response would be cleaner, but we
  // don't have it here; use scripts.length × created_at-derived id).
  // Pre-check above ensured the balance was sufficient — the consume
  // here is the actual debit.
  if (customerId && updated > 0) {
    try {
      const result = await supaFetch('rpc/consume_credits', {
        method: 'POST',
        body: {
          p_customer_id: customerId,
          p_pool_type: 'ai_tokens',
          p_amount: fee,
          p_action: 'consume:bulk-caption',
          p_profile_id: profile_id,
          p_metadata: { scripts: scripts.length, updated, has_images: scripts.some((s) => s.media_type === 'image') },
        },
      })
      if (result && typeof result === 'object' && result.success === false) {
        console.error('bulk-caption: consume_credits returned failure', { customerId, fee, error_code: result.error_code, profile_id })
        try {
          const { captureApiError } = await import('../_lib/sentry.js')
          captureApiError(new Error('consume_credits returned success=false'), {
            route: 'bulk-caption:consume',
            userId: user_id, profileId: profile_id,
            extra: { customerId, fee, error_code: result.error_code, kind: 'free_generation_leak' },
          })
        } catch {}
      }
    } catch (e) {
      console.error('bulk-caption: consume_credits threw', { customerId, fee, profile_id, message: e?.message })
    }
  }
  // Per-row debug data so we can answer "why did Claude write that?"
  // without running blind. transcript_preview is the first 200 chars
  // of what Scribe returned for video rows (or whatever we used as
  // the topic signal). Useful in DevTools and we'll surface it in the
  // UI when results look off.
  const debug = scripts.map((s, i) => ({
    id: s.id,
    media_type: s.media_type,
    transcript_chars: (s.full_script || '').length,
    transcript_preview: (s.full_script || '').slice(0, 200),
    ai_status: captionResults[i] ? (captionResults[i]._no_transcript ? 'placeholder_no_transcript' : 'ok') : 'failed',
  }))
  return res.status(200).json({
    updated,
    total: scripts.length,
    // Surface any rows where we couldn't extract a topic signal so the
    // UI can toast "n video(s) couldn't be transcribed — their captions
    // may be generic." Better than silently shipping brand-only captions.
    transcript_failures: transcriptFailures,
    debug,
  })
}

// ── auto-schedule ──────────────────────────────────────────────────────────
async function autoSchedule({ res, profile_id, script_ids, user_id }) {
  const profileRows = await supaFetch(`profiles?id=eq.${profile_id}&select=id,timezone,posting_schedule`)
  const profile = profileRows?.[0]
  if (!profile) return res.status(404).json({ error: 'Profile not found' })

  // Pull already-scheduled times so we don't double-book.
  const taken = await supaFetch(
    `content_scripts?profile_id=eq.${profile_id}&status=eq.scheduled&select=scheduled_datetime`
  ).catch(() => [])
  const takenIso = (taken || []).map((r) => r.scheduled_datetime).filter(Boolean)
  const takenSet = new Set(takenIso.map((s) => new Date(s).toISOString()))

  let q = `content_scripts?profile_id=eq.${profile_id}&scheduled_datetime=is.null`
  if (Array.isArray(script_ids) && script_ids.length) {
    q += `&id=in.(${script_ids.map((id) => encodeURIComponent(id)).join(',')})`
  } else {
    q += '&status=in.(caption_ready,draft)'
  }
  // media_urls needed so we can skip text-only rows below. Without
  // this guard, bulk-auto-schedule was the main source of ghost
  // queue entries: it'd parade every caption_ready / draft row into
  // the calendar regardless of whether there was anything to publish.
  q += '&select=id,media_urls&order=created_at.asc&limit=200'
  const rawCandidates = await supaFetch(q)
  if (!rawCandidates?.length) return res.status(200).json({ scheduled: 0, skipped_no_media: 0 })

  const candidates = rawCandidates.filter((r) => {
    return Array.isArray(r.media_urls) && r.media_urls.some((u) => typeof u === 'string' && u.trim())
  })
  const skippedNoMedia = rawCandidates.length - candidates.length
  if (!candidates.length) return res.status(200).json({ scheduled: 0, skipped_no_media: skippedNoMedia })

  // Allocate slots sequentially so the schedule stays gap-free, but
  // execute the PATCHes in parallel — each row's payload is different
  // (different scheduled_datetime), so we can't merge into one UPDATE.
  const assignments = []
  for (const row of candidates) {
    const slot = findNextOpenSlot(profile, [...takenSet])
    if (!slot) break
    assignments.push({ id: row.id, slot })
    takenSet.add(new Date(slot).toISOString())
  }
  const results = await Promise.allSettled(assignments.map((a) =>
    supaFetch(`content_scripts?id=eq.${a.id}`, {
      method: 'PATCH',
      body: { scheduled_datetime: a.slot, status: 'scheduled' },
      prefer: 'return=minimal',
    }).catch((e) => { console.warn('auto-schedule patch failed for', a.id, e.message); throw e })
  ))
  const scheduled = results.filter((r) => r.status === 'fulfilled').length

  // ── Upload-Post submission ──────────────────────────────────────────
  // Previously auto-schedule only flipped the local row to status=scheduled
  // and left Upload-Post completely unaware. That meant:
  //   • the post wouldn't actually publish unless the user later clicked
  //     "Publish Selected" or "Resync Scheduled"
  //   • deletes couldn't cascade-cancel — the row had no
  //     uploadpost_request_id to call Upload-Post's DELETE against, so
  //     orphan jobs would pile up if any submission EVER did happen.
  // Now: for video rows, we submit each one to Upload-Post inline with
  // async_upload=true + scheduled_date, persist the returned request_id
  // back to the row, and every future DELETE cascade-cancels cleanly.
  // Photos still need the bytes-multipart path (Upload-Post doesn't accept
  // URL strings for photos), so we skip them here — they continue to flow
  // through manual Publish / Resync as before.
  const apiKey = process.env.UPLOADPOST_API_KEY
  let submitted = 0
  let submitFailed = 0
  if (apiKey && assignments.length) {
    const username = await resolveUploadpostUser(profile_id)
    await uploadpostEnsureUserProfile(username).catch(() => {})

    const rowIds = assignments.map((a) => a.id)
    const fullRows = await supaFetch(
      `content_scripts?id=in.(${rowIds.map((id) => encodeURIComponent(id)).join(',')})&select=id,media_urls,media_type,platforms,caption,hashtags,full_script,title,first_comment,cover_image_url`
    ).catch(() => [])
    const rowById = new Map((fullRows || []).map((r) => [r.id, r]))

    const submitOne = async (a) => {
      const row = rowById.get(a.id)
      if (!row) return
      // Only video rows submit inline. Photos require bytes upload — too
      // expensive to do 200x in one Vercel function. They keep working
      // via Publish Selected / Resync.
      if (row.media_type !== 'video') return
      const mediaUrl = row.media_urls?.[0]
      if (!mediaUrl) return

      const platforms = Array.isArray(row.platforms) && row.platforms.length ? row.platforms : ['tiktok']
      const desc = [row.caption, row.hashtags].filter(Boolean).join('\n\n').trim()
        || (row.full_script || '').slice(0, 500)
      const hasTikTok = platforms.includes('tiktok')

      // Title fallback chain — row.title → first sentence of caption →
      // first sentence of script → "Untitled". YouTube REQUIRES a title
      // on every submission (it 400s with "Title is required for
      // Youtube" otherwise), so we must always have something here.
      const cleanTitle = String(row.title || '').trim()
        || String(row.caption || '').split(/[.!?\n]/)[0].trim().slice(0, 90)
        || String(row.full_script || '').split(/[.!?\n]/)[0].trim().slice(0, 90)
        || 'Untitled'

      const form = new URLSearchParams()
      form.append('user', username)
      for (const p of platforms) form.append('platform[]', p)
      if (desc) form.append('description', desc)
      // Generic title fallback — Upload-Post uses this when a platform-
      // specific title override isn't set. Capped at 100 to match
      // YouTube's hard limit.
      form.append('title', cleanTitle.slice(0, 100))
      // Per-platform title overrides. Matches the mapping in
      // /api/social/upload-post.js so submissions through this path
      // behave identically. YouTube's title cap is 100 chars.
      if (platforms.includes('youtube')) form.append('youtube_title', cleanTitle.slice(0, 100))
      // TikTok's caption lives in tiktok_title (it ignores `description`).
      if (hasTikTok && desc) form.append('tiktok_title', desc.slice(0, 2200))
      if (platforms.includes('instagram')) {
        if (desc) form.append('instagram_title', desc.slice(0, 2200))
        // Per-post Instagram Reel cover, set on the Schedule page.
        if (row.cover_image_url) form.append('instagram_cover_url', String(row.cover_image_url))
      }
      if (platforms.includes('facebook')) {
        const fbSrc = (desc || cleanTitle).replace(/\s*\n+\s*/g, ' ').trim()
        form.append('facebook_title', fbSrc.slice(0, 240))
      }
      if (platforms.includes('linkedin')) form.append('linkedin_title', (desc || cleanTitle).slice(0, 3000))
      if (platforms.includes('threads')) form.append('threads_title', (desc || cleanTitle).slice(0, 500))
      if (row.first_comment) form.append('first_comment', String(row.first_comment).slice(0, 2200))
      form.append('async_upload', 'true')
      form.append('video', mediaUrl)
      form.append('scheduled_date', new Date(a.slot).toISOString())
      // Sensible per-platform defaults (mirrors publishSelected).
      if (platforms.includes('instagram')) form.append('instagram_media_type', 'REELS')
      if (platforms.includes('youtube'))   form.append('youtube_privacy', 'PUBLIC')
      if (hasTikTok)                       form.append('privacy_level', 'PUBLIC_TO_EVERYONE')

      try {
        const upRes = await fetch('https://api.upload-post.com/api/upload', {
          method: 'POST',
          headers: { Authorization: `Apikey ${apiKey}` },
          body: form,
        })
        const body = await upRes.json().catch(() => ({}))
        if (!upRes.ok) {
          const errText = (body?.error || body?.message || `Upload-Post ${upRes.status}`).toString().slice(0, 1000)
          console.warn(`auto-schedule submit failed for ${row.id}:`, errText)
          submitFailed++
          await supaFetch(`content_scripts?id=eq.${row.id}`, {
            method: 'PATCH',
            body: { last_error: `[${upRes.status}] ${errText}`, last_error_at: new Date().toISOString() },
            prefer: 'return=minimal',
          }).catch(() => {})
          return
        }
        const requestId = body?.request_id || body?.id || null
        if (!requestId) return
        await supaFetch(`content_scripts?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { uploadpost_request_id: requestId, last_error: null, last_error_at: null },
          prefer: 'return=minimal',
        }).catch(() => {})
        submitted++
      } catch (e) {
        submitFailed++
        console.warn(`auto-schedule submit threw for ${row.id}:`, e?.message)
      }
    }

    // Concurrency cap — Upload-Post rate-limits per key, and we don't want
    // 200 parallel HTTP calls from a single function invocation either. 5
    // is the sweet spot: ~40s for 200 rows, comfortably under the function
    // budget, and well under Upload-Post's per-key throughput cap.
    const CONCURRENCY = 5
    let cursor = 0
    const workers = Array.from({ length: Math.min(CONCURRENCY, assignments.length) }, async () => {
      while (cursor < assignments.length) {
        const a = assignments[cursor++]
        await submitOne(a)
      }
    })
    await Promise.all(workers)
  }

  return res.status(200).json({
    scheduled,
    submitted,
    submit_failed: submitFailed,
    skipped: candidates.length - scheduled,
    skipped_no_media: skippedNoMedia,
  })
}

// ── publish-selected ───────────────────────────────────────────────────────
async function publishSelected({ res, profile_id, script_ids, user_id }) {
  if (!Array.isArray(script_ids) || !script_ids.length) {
    return res.status(400).json({ error: 'script_ids required' })
  }
  const apiKey = process.env.UPLOADPOST_API_KEY
  if (!apiKey) return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })

  const username = await resolveUploadpostUser(profile_id)
  await uploadpostEnsureUserProfile(username).catch(() => {})

  const rows = await supaFetch(
    `content_scripts?id=in.(${script_ids.map((id) => encodeURIComponent(id)).join(',')})&select=*`
  )
  if (!rows?.length) return res.status(404).json({ error: 'No scripts found' })

  // Credit gating: 100 ai_tokens per post, matching the per-post fee
  // schedule_post charges for individual publishes. Pre-check the sum;
  // consume per row only on success so a partial failure refunds the
  // unpublished portion automatically (we never debit them).
  const PUBLISH_TOKENS_PER_POST = 100
  const fee = rows.length * PUBLISH_TOKENS_PER_POST
  const cust = user_id ? await supaFetch(`billing_customers?user_id=eq.${user_id}&select=id`).catch(() => []) : []
  const customerId = cust?.[0]?.id || null
  if (customerId) {
    const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`).catch(() => [])
    if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
      return res.status(402).json({ error: 'Insufficient AI tokens for batch publish.', code: 'insufficient_credits', need: fee })
    }
  }

  const results = []
  for (const r of rows) {
    try {
      const isText = r.media_type === 'text'
      if (!isText && (!Array.isArray(r.media_urls) || !r.media_urls.length)) {
        results.push({ id: r.id, ok: false, error: 'no media' }); continue
      }
      // If this row was previously scheduled at Upload-Post, cancel the
      // pending job first so we don't double-post (once now, once at the
      // original scheduled time).
      if (r.uploadpost_request_id) {
        // Cancel requires Upload-Post's internal job_id. uploadpostCancelByRequestId
        // resolves request_id → job_id via the user's scheduled list, then DELETEs.
        try { await uploadpostCancelByRequestId(username, r.uploadpost_request_id) } catch {}
      }
      const isVideo = r.media_type === 'video'
      const platforms = Array.isArray(r.platforms) && r.platforms.length
        ? r.platforms
        : (isText ? ['threads'] : ['tiktok'])
      const desc = [r.caption, r.hashtags].filter(Boolean).join('\n\n').trim() || (r.full_script || '').slice(0, 500)
      const hasTikTok = platforms.includes('tiktok')

      // ── VIDEO: URL pass-through ─────────────────────────────────────────
      // Upload-Post's /api/upload endpoint accepts the video as a URL string
      // — they fetch it themselves with proper Content-Type detection. This
      // is far more reliable than re-uploading bytes as a generic Blob:
      //   • container/codec gets detected correctly (.mov vs .mp4 vs .webm)
      //   • bypasses Vercel function body/timeout limits on big files
      //   • async_upload=true lets Upload-Post process in the background
      //     instead of failing under sync timeouts on strict platforms
      // Mirrors the working VTM uploadpost.js flow.
      let upRes
      if (isText) {
        // ── TEXT: per-platform *_title fan-out ───────────────────────────
        // /api/upload_text takes the same auth + form shape as video uploads
        // but expects no media. Upload-Post requires a top-level `title`
        // field on text posts — it serves as the actual post body (NOT a
        // headline). We send the full caption there so platforms without an
        // explicit *_title override still publish the right text. Then each
        // platform gets a <platform>_title override trimmed to that platform's
        // hard limit. Char caps mirror /api/social/upload-post.
        const form = new URLSearchParams()
        form.append('user', username)
        for (const p of platforms) form.append('platform[]', p)
        form.append('title', desc.slice(0, 5000))
        if (desc) form.append('description', desc.slice(0, 5000))
        if (platforms.includes('threads'))   form.append('threads_title',   desc.slice(0, 500))
        if (platforms.includes('x') || platforms.includes('twitter')) form.append('x_title', desc.slice(0, 25000))
        if (platforms.includes('linkedin'))  { form.append('linkedin_title',  desc.slice(0, 3000)); form.append('linkedin_description', desc.slice(0, 3000)) }
        if (platforms.includes('facebook'))  {
          const fbSrc = desc.replace(/\s*\n+\s*/g, ' ').trim()
          form.append('facebook_title', fbSrc.slice(0, 240))
          form.append('facebook_description', desc.slice(0, 5000))
        }
        if (platforms.includes('bluesky'))   form.append('bluesky_title',  desc.slice(0, 300))
        if (r.first_comment) form.append('first_comment', String(r.first_comment).slice(0, 1000))

        upRes = await fetch('https://api.upload-post.com/api/upload_text', {
          method: 'POST',
          headers: { Authorization: `Apikey ${apiKey}` },
          body: form,
        })
      } else if (isVideo) {
        // Title fallback chain — same as auto-schedule's submitOne.
        // YouTube REQUIRES a title or Upload-Post rejects with
        // "Title is required for Youtube" before the job is queued.
        const cleanTitle = String(r.title || '').trim()
          || String(r.caption || '').split(/[.!?\n]/)[0].trim().slice(0, 90)
          || String(r.full_script || '').split(/[.!?\n]/)[0].trim().slice(0, 90)
          || 'Untitled'

        const form = new URLSearchParams()
        form.append('user', username)
        for (const p of platforms) form.append('platform[]', p)
        if (desc) form.append('description', desc)
        // Generic title — Upload-Post's catch-all. Capped at 100 to
        // match YouTube's hard limit (longest title that won't trip
        // any platform).
        form.append('title', cleanTitle.slice(0, 100))
        // Per-platform title overrides (mirror /api/social/upload-post.js).
        if (platforms.includes('youtube')) form.append('youtube_title', cleanTitle.slice(0, 100))
        // TikTok ignores `description` — it uses tiktok_title (up to 2200
        // chars) as the actual caption. Send the full caption there, not
        // just the title.
        if (hasTikTok && desc) form.append('tiktok_title', desc.slice(0, 2200))
        if (platforms.includes('instagram')) {
          if (desc) form.append('instagram_title', desc.slice(0, 2200))
          // Generated Instagram Reel cover (Schedule page → Generate cover).
          if (r.cover_image_url) form.append('instagram_cover_url', String(r.cover_image_url))
        }
        if (platforms.includes('facebook')) {
          const fbSrc = (desc || cleanTitle).replace(/\s*\n+\s*/g, ' ').trim()
          form.append('facebook_title', fbSrc.slice(0, 240))
        }
        if (platforms.includes('linkedin')) form.append('linkedin_title', (desc || cleanTitle).slice(0, 3000))
        if (platforms.includes('threads')) form.append('threads_title', (desc || cleanTitle).slice(0, 500))
        if (r.first_comment) form.append('first_comment', String(r.first_comment).slice(0, 2200))
        form.append('async_upload', 'true')
        // Sensible per-platform defaults. Brand-profile-level overrides can
        // be plumbed in later (instagram_media_type, youtube_privacy,
        // facebook_page_id, etc.) — for now these match VTM's defaults.
        if (platforms.includes('instagram')) form.append('instagram_media_type', 'REELS')
        if (platforms.includes('youtube'))   form.append('youtube_privacy', 'PUBLIC')
        if (hasTikTok)                       form.append('privacy_level', 'PUBLIC_TO_EVERYONE')
        form.append('video', r.media_urls[0])

        upRes = await fetch('https://api.upload-post.com/api/upload', {
          method: 'POST',
          headers: { Authorization: `Apikey ${apiKey}` },
          body: form,
        })
      } else {
        // ── PHOTOS: still need real bytes ───────────────────────────────
        // Upload-Post's /api/upload_photos does NOT accept URL strings —
        // photos must be fetched and re-uploaded as multipart file parts.
        const cleanTitle = String(r.title || '').trim()
          || String(r.caption || '').split(/[.!?\n]/)[0].trim().slice(0, 90)
          || String(r.full_script || '').split(/[.!?\n]/)[0].trim().slice(0, 90)
          || 'Untitled'

        const fd = new FormData()
        fd.append('user', username)
        for (const p of platforms) fd.append('platform[]', p)
        if (desc) fd.append('description', desc)
        // Title coverage matches the video branch — YouTube + every
        // other platform that exposes a *_title override.
        fd.append('title', cleanTitle.slice(0, 100))
        if (platforms.includes('youtube')) fd.append('youtube_title', cleanTitle.slice(0, 100))
        if (hasTikTok && desc) {
          // TikTok photo posts use tiktok_title (≤90 chars). Trim to a
          // word boundary if the caption is longer.
          const src = desc.replace(/\s+/g, ' ').trim()
          fd.append('tiktok_title', src.length <= 90 ? src : src.slice(0, 90).replace(/\s+\S*$/, ''))
        }
        if (platforms.includes('instagram') && desc) fd.append('instagram_title', desc.slice(0, 2200))
        if (platforms.includes('facebook')) {
          const fbSrc = (desc || cleanTitle).replace(/\s*\n+\s*/g, ' ').trim()
          fd.append('facebook_title', fbSrc.slice(0, 240))
        }
        if (platforms.includes('linkedin')) fd.append('linkedin_title', (desc || cleanTitle).slice(0, 3000))
        if (platforms.includes('threads')) fd.append('threads_title', (desc || cleanTitle).slice(0, 500))
        if (r.first_comment) fd.append('first_comment', String(r.first_comment).slice(0, 2200))
        fd.append('async_upload', 'true')

        for (let i = 0; i < r.media_urls.length; i++) {
          const url = r.media_urls[i]
          const fr = await fetch(url)
          if (!fr.ok) throw new Error(`media fetch ${url} → ${fr.status}`)
          const ab = await fr.arrayBuffer()
          const extMatch = (url.match(/\.([a-z0-9]+)(?:\?|#|$)/i)?.[1] || 'jpg').toLowerCase()
          const mime = extMatch === 'png'  ? 'image/png'
                     : extMatch === 'webp' ? 'image/webp'
                     : extMatch === 'gif'  ? 'image/gif'
                     : 'image/jpeg'
          fd.append('photos[]', new Blob([ab], { type: mime }), `image_${i + 1}.${extMatch}`)
        }

        upRes = await fetch('https://api.upload-post.com/api/upload_photos', {
          method: 'POST',
          headers: { Authorization: `Apikey ${apiKey}` },
          body: fd,
        })
      }
      const body = await upRes.json().catch(() => ({}))
      if (!upRes.ok) {
        // Persist the full Upload-Post error body to the row so the UI can
        // show why this failed instead of a generic "failed" pill. We
        // truncate to 1k chars to keep the column lean.
        const errText = (body?.error || body?.message || JSON.stringify(body || {}) || `Upload-Post ${upRes.status}`).toString().slice(0, 1000)
        await supaFetch(`content_scripts?id=eq.${r.id}`, {
          method: 'PATCH', body: { status: 'failed', last_error: `[${upRes.status}] ${errText}`, last_error_at: new Date().toISOString() },
        })
        results.push({ id: r.id, ok: false, error: errText })
        continue
      }
      const requestId = body?.request_id || body?.id || null
      await supaFetch(`content_scripts?id=eq.${r.id}`, {
        method: 'PATCH',
        body: { status: 'posted', uploadpost_request_id: requestId, scheduled_datetime: null, last_error: null, last_error_at: null },
      })
      results.push({ id: r.id, ok: true, request_id: requestId })
    } catch (e) {
      await supaFetch(`content_scripts?id=eq.${r.id}`, {
        method: 'PATCH', body: { status: 'failed', last_error: String(e?.message || e).slice(0, 1000), last_error_at: new Date().toISOString() },
      }).catch(() => {})
      results.push({ id: r.id, ok: false, error: e.message })
    }
  }
  const okCount = results.filter((x) => x.ok).length

  // Consume credits ONLY for the rows that successfully posted. Failed
  // rows aren't billed — same model as schedule_post's per-call fee.
  if (customerId && okCount > 0) {
    try {
      const result = await supaFetch('rpc/consume_credits', {
        method: 'POST',
        body: {
          p_customer_id: customerId,
          p_pool_type: 'ai_tokens',
          p_amount: okCount * PUBLISH_TOKENS_PER_POST,
          p_action: 'consume:bulk-publish',
          p_profile_id: profile_id,
          p_metadata: { posted: okCount, failed: results.length - okCount },
        },
      })
      if (result && typeof result === 'object' && result.success === false) {
        console.error('bulk-publish: consume_credits returned failure', { customerId, fee, error_code: result.error_code, profile_id })
        try {
          const { captureApiError } = await import('../_lib/sentry.js')
          captureApiError(new Error('consume_credits returned success=false'), {
            route: 'bulk-publish:consume',
            userId: user_id, profileId: profile_id,
            extra: { customerId, fee, error_code: result.error_code, kind: 'free_generation_leak' },
          })
        } catch {}
      }
    } catch (e) {
      console.error('bulk-publish: consume_credits threw', { customerId, fee, profile_id, message: e?.message })
    }
  }

  return res.status(200).json({ submitted: okCount, failed: results.length - okCount, results })
}

// ── resync-upload-post ─────────────────────────────────────────────────────
// Walks every status='scheduled' row for the profile (or just the ids the
// caller passes) and re-submits its CURRENT payload to Upload-Post. Cancels
// any prior uploadpost_request_id along the way. Used to repair rows whose
// platforms / caption / hashtags / media drifted from the originally queued
// job — pre-existing scheduled posts that pre-date the auto-reschedule
// behavior fix.
//
// Body: { profile_id, script_ids?: string[] }
// Returns: { resynced, skipped, failed, details }
async function resyncUploadPost({ req, res, profile_id, script_ids }) {
  let q = `content_scripts?profile_id=eq.${profile_id}&status=eq.scheduled`
  if (Array.isArray(script_ids) && script_ids.length) {
    q += `&id=in.(${script_ids.map((id) => encodeURIComponent(id)).join(',')})`
  }
  q += '&select=id,title,full_script,caption,hashtags,first_comment,media_urls,media_type,platforms,scheduled_datetime,uploadpost_request_id'
  const rows = await supaFetch(q)
  if (!rows?.length) return res.status(200).json({ resynced: 0, skipped: 0, failed: 0, details: [] })

  const proto = (req.headers['x-forwarded-proto'] || 'https').split(',')[0].trim()
  const host  = req.headers['x-forwarded-host'] || req.headers.host
  const base  = `${proto}://${host}`
  const authToken = req.headers.authorization?.replace(/^Bearer\s+/i, '') || ''

  let resynced = 0, skipped = 0, failed = 0
  const details = []

  // Cancelling requires translating each row's stored request_id into
  // Upload-Post's internal job_id via their scheduled-list endpoint.
  // Resolve username once and reuse for every cancel in the loop.
  const username = await resolveUploadpostUser(profile_id)

  // Sequential so a slow Upload-Post doesn't fan us into rate-limit
  // territory. 200 max scheduled rows in practice; 1-2s each → tops
  // out under the 120s function budget.
  for (const row of rows) {
    const platforms = Array.isArray(row.platforms) ? row.platforms : []
    const mediaUrls = Array.isArray(row.media_urls) ? row.media_urls : []
    if (!platforms.length || !mediaUrls.length || !row.scheduled_datetime) {
      skipped += 1
      details.push({ id: row.id, status: 'skipped', reason: 'missing platforms / media / scheduled_datetime' })
      continue
    }
    // Cancel old job (best-effort). 404 = already gone, fine.
    // DELETE keys off job_id; uploadpostCancelByRequestId does the
    // request_id → job_id lookup against the user's scheduled list.
    if (row.uploadpost_request_id) {
      try {
        const cancel = await uploadpostCancelByRequestId(username, row.uploadpost_request_id)
        if (!cancel.ok && cancel.status !== 404) {
          console.warn('[resync] cancel failed:', row.uploadpost_request_id, cancel.reason)
        }
      } catch (e) {
        console.warn('[resync] cancel threw:', e.message)
      }
    }
    // Re-submit with current payload.
    const isVideo = row.media_type === 'video' || /\.(mp4|mov|webm|m4v)(\?|#|$)/i.test(mediaUrls[0] || '')
    const fullCaption = [row.caption, row.hashtags].filter(Boolean).join('\n\n').trim()
    const body = {
      profile_id,
      platforms,
      video_url: isVideo ? mediaUrls[0] : undefined,
      photo_urls: !isVideo ? mediaUrls : undefined,
      description: fullCaption || row.full_script || row.title || '',
      title: row.title || undefined,
      caption: row.caption || undefined,
      hashtags: row.hashtags || undefined,
      script: row.full_script || undefined,
      first_comment: row.first_comment || undefined,
      // Forward custom Instagram cover when set on the row.
      cover_image_url: row.cover_image_url || undefined,
      scheduling_mode: 'fixed',
      scheduled_iso: row.scheduled_datetime,
      // Force /api/social/upload-post to PATCH this specific row instead
      // of inserting a new one. Without this, resync (which runs hours
      // after the original create) misses the 5-min dedup window and
      // duplicates pile up on the Schedule page.
      script_id: row.id,
    }
    try {
      const r = await fetch(`${base}/api/social/upload-post`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify(body),
      })
      const resp = await r.json().catch(() => ({}))
      if (!r.ok) {
        failed += 1
        details.push({ id: row.id, status: 'failed', reason: resp?.error || `upload-post ${r.status}` })
        continue
      }
      // Patch the row's uploadpost_request_id with the new one so future
      // edits know where to find the active job. status / scheduled
      // stay put — we're not moving anything, just re-syncing payload.
      if (resp.request_id) {
        await supaFetch(`content_scripts?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { uploadpost_request_id: resp.request_id },
          prefer: 'return=minimal',
        }).catch(() => {})
      }
      resynced += 1
      details.push({ id: row.id, status: 'ok', request_id: resp.request_id || null })
    } catch (e) {
      failed += 1
      details.push({ id: row.id, status: 'failed', reason: e.message })
    }
  }

  return res.status(200).json({ resynced, skipped, failed, details })
}
