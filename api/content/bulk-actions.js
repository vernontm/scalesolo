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

import { setCors, requireUser, supaFetch, assertMinRole, fmtErr } from '../_lib/supabase.js'
import { findNextOpenSlot } from '../_lib/scheduling.js'
import { message } from '../_lib/anthropic.js'
import { loadBrandContext, renderBrandContextMarkdown } from '../_lib/brand-context.js'
import { transcribeFromUrl } from '../_lib/scribe.js'
import { extractFramesFromUrl, framesToVisionBlocks } from '../_lib/frames.js'
import {
  uploadpostCancelByRequestId,
  resolveUploadpostUser,
  uploadpostEnsureUserProfile,
} from '../_lib/uploadpost.js'
import uploadPostHandler from '../social/upload-post.js'
import { invokeHandler } from '../_lib/internal-invoke.js'
import { capHashtags } from '../_lib/hashtags.js'
import sharp from 'sharp'

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

  try {
    // assertProfileAccess was being called OUTSIDE the try/catch, so a
    // throw there (e.g. profile not in the user's allowed set, malformed
    // uuid) bypassed the dispatcher's catch and surfaced as a generic
    // 500 with no useful payload. Moved inside.
    // Every action here writes / spends (caption gen, schedule, publish, resync) — editor+.
    await assertMinRole(auth.user.id, profile_id, 'editor')
    if (action === 'generate-captions') return generateCaptions({ res, profile_id, script_ids, user_id: auth.user.id })
    if (action === 'auto-schedule')     return autoSchedule({ res, profile_id, script_ids, user_id: auth.user.id })
    if (action === 'publish-selected')  return publishSelected({ req, res, profile_id, script_ids, user_id: auth.user.id })
    if (action === 'resync-upload-post') return resyncUploadPost({ req, res, profile_id, script_ids })
    return res.status(400).json({ error: `Unknown action: ${action}` })
  } catch (err) {
    console.error('bulk-actions error:', err?.stack || err)
    return res.status(err.status || 500).json({ error: fmtErr(err) })
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
  q += '&select=id,title,full_script,hook,caption,media_type,media_urls,status,scheduled_datetime,uploadpost_request_id,uploadpost_job_id'
  const scripts = await supaFetch(q)
  if (!scripts?.length) return res.status(200).json({ updated: 0 })

  // Credit gating. Video rows now run hybrid (transcript + 6 keyframes)
  // by default so Claude can read on-screen text — that pushes input
  // tokens to ~10-12K per video row (vs ~3K transcript-only). Bumped
  // from 3000 to 6000 so the pre-debit balance check matches actual
  // usage on the mixed batches that the UI submits. Image rows still
  // use one image block (~1.5K) so they're over-charged by ~3x here,
  // but image-only batches are uncommon enough that flat per-script
  // pricing keeps the consume call simple. Worth revisiting with
  // per-media-type pricing if image batches become a hot path.
  const CAPTION_TOKENS_PER_SCRIPT = 6000
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
  // A credit / attribution line (e.g. "📷: @rayvaughnceo") is not a phrase to
  // weave into a sentence — it must land verbatim as the caption's final line.
  // Partition those out of always_include so they're (a) NOT fed to the model
  // as "include one of these" (which would let it paraphrase or misplace them)
  // and (b) appended deterministically after generation. Everything else stays
  // a normal always-include phrase.
  const isCreditLine = (s) => /^\s*(📷|📸|🎥|🎬|🎞|credit\s*:|shot by|filmed by|📷:)/i.test(String(s || ''))
  const creditEntries  = aiArr.filter(isCreditLine).map((s) => String(s).trim())
  const includeArr = aiArr.filter((s) => !isCreditLine(s))
  const ctaStr = (profile.brand_cta || '').trim()
  const ruleLines = []
  // Topic-match override (read first). A brand whose usual subject is X (e.g. an
  // AI-automation brand) also posts off-topic videos: food reviews, testimonials,
  // venue clips, plain page/event promos. Those must NOT inherit the brand's
  // product, signature "comment KEYWORD" hooks, or product hashtags. This one
  // rule scopes the CTA menu, core hashtags, and always-include rules below so a
  // food review never closes with "Comment AI" or gets #chatgpt.
  ruleLines.push('- TOPIC MATCH (read first): decide what THIS video is actually about from its transcript/frames. If its real subject does not fit the brand\'s usual topic (for example a food review, a customer testimonial, a venue or location clip, or a plain page or event promo), then the title, caption, hashtags, first comment, and CTA must be about THAT subject only. Do NOT insert the brand\'s product, offers, signature keywords, "comment KEYWORD" hooks, or product hashtags in that case, even if they are listed below. The brand rules below apply only when the video genuinely fits the brand\'s usual topic.')
  if (dnsArr.length) ruleLines.push(`- NEVER use these words/phrases: ${dnsArr.map((s) => `"${s}"`).join(', ')}`)
  if (includeArr.length)  ruleLines.push(`- ALWAYS include at least one of: ${includeArr.map((s) => `"${s}"`).join(', ')}`)
  // CTA selection. brand_ctas (jsonb array of {label, url, when}) is the
  // multi-CTA menu: Claude picks the ONE best-fit CTA per post based on
  // the content, so an AI-group recap gets the event CTA while a tool
  // tutorial gets the guide CTA — instead of every post closing the
  // same way. Falls back to the legacy single brand_cta text when no
  // menu is configured.
  const ctaMenu = Array.isArray(profile.brand_ctas) ? profile.brand_ctas.filter((c) => c && c.label) : []
  if (ctaMenu.length) {
    const menuLines = ctaMenu.map((c, i) =>
      `  ${i + 1}. "${c.label}"${c.url ? ` → ${c.url}` : ''} — best fit: ${c.when || 'any post'}`)
    ruleLines.push(`- CTA MENU: pick the ONE whose "best fit" matches what this video is actually about (do not default to the first; vary across posts). If NONE fit the video's real topic, per the topic-match rule use NO brand CTA at all and write a short natural CTA or question about what is on screen:\n${menuLines.join('\n')}`)
  } else if (ctaStr) {
    ruleLines.push(`- Brand CTA (use when natural): "${ctaStr}"`)
  }
  const badPatternsBlock = renderBrandContextMarkdown(ctx, { include: ['bad_patterns'] })
  const coreHashtagsLine = profile.core_hashtags
    ? `Core brand hashtags (lead with these ONLY when the video fits the brand's usual topic; for off-topic videos like food reviews or promos, use hashtags that match what is actually shown instead): ${profile.core_hashtags}`
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

  // Shared caption-length contract for every prompt variant below.
  // Product decision (user feedback 2026-07): generated captions were
  // landing ~900+ chars of stacked paragraphs and Ray was hand-cutting
  // them to a third of that before posting. Tight beats long: a CTA/
  // hook line, one or two short beats, a closer. Keep this ONE constant
  // so the four prompt variants can't drift apart on length rules.
  const CAPTION_LENGTH_RULE = 'The caption MUST be 250-450 characters TOTAL (hard cap 450 — count characters, not words). Structure: one CTA or hook line, then 1-2 short beats, then a one-line closer. Blank line between each. No stacked story paragraphs, no repeating what the video already says.'

  // Truth guardrail applied to every prompt variant. Root-caused from a
  // real incident (2026-08): a POV skit where a celebrity "walks in" to a
  // restaurant got captioned as if the star had actually visited. The
  // model treats an on-screen premise as literal, so we spell it out —
  // dramatizations are fiction, and we never assert unverifiable real-
  // world facts about real people.
  const TRUTH_RULE = 'TRUTH: Do NOT state anything as real fact that you cannot verify from the brand context. Skits, POV setups, jokes, look-alikes, and dramatizations are creative premises, not real events: write around the concept, the feeling, or the viewer, not as something that happened. NEVER claim a real or famous person actually visited, endorsed, ate at, or said anything about the brand, and never put words in a real person\'s mouth. If a frame or on-screen line implies a celebrity or an event that did not verifiably happen, treat it as the setup (address the viewer, play up the vibe), not as fact. When unsure whether a detail is real, describe the experience, not the claim.'

  // Distinguish real spoken narration from background-music lyrics. Scribe
  // transcribes SINGING as if it were speech, so a food B-roll set to a song
  // comes back with a "transcript" full of lyrics. Those lyrics are not the
  // subject of the video, and feeding them to the model produces captions
  // "about the song" instead of the food. When we already have keyframes, we
  // only keep a transcript that shows a real promo/narration signal (the brand
  // name, a brand term, or a call-to-action cue); otherwise we drop it and
  // caption from the frames alone. Conservative on purpose: genuine owner /
  // creator narration almost always names the place or includes a CTA, so it
  // survives, while a pure song is dropped.
  const NARRATION_CUES = ['check out', 'come in', 'come by', 'come see', 'come and', 'stop by', 'pull up', 'visit us', 'visit our', 'swing by', 'link in bio', 'follow us', 'subscribe', 'order', 'on the menu', 'open now', 'now open', 'grab a', 'grab your', 'get yours', 'try our', 'try the', 'try this', 'welcome to', 'happy hour', 'dine in', 'pickup', 'take out', 'takeout', 'delivery', 'book a', 'reserve', 'call us', 'tag a', 'tag your', 'comment below', 'save this', 'drop a', 'new location', 'grand opening', 'this weekend', 'see you', 'make sure']
  const looksLikeNarration = (transcript) => {
    const t = String(transcript || '').toLowerCase()
    if (t.length < 30) return false
    const name = String(profile.business_name || '').toLowerCase().trim()
    if (name.length >= 3 && t.includes(name)) return true
    const terms = []
    if (Array.isArray(profile.always_include)) terms.push(...profile.always_include)
    if (profile.core_hashtags) terms.push(...String(profile.core_hashtags).split(/[\s,]+/))
    for (const raw of terms) {
      const w = String(raw || '').replace(/^#/, '').toLowerCase().trim()
      if (w.length >= 4 && t.includes(w)) return true
    }
    return NARRATION_CUES.some((c) => t.includes(c))
  }

  // Append any brand credit / attribution line verbatim as the caption's final
  // line, below a three-dot spacer (pushes it under Instagram's "more" fold).
  // Dedup-guarded so re-running Generate Captions can't stack duplicates.
  const applyCreditLine = (caption) => {
    if (caption == null) return caption
    const lines = creditEntries.filter(Boolean)
    if (!lines.length) return caption
    const out = String(caption).trimEnd()
    const missing = lines.filter((l) => !out.includes(l))
    if (!missing.length) return out
    return `${out}\n.\n.\n.\n\n${missing.join('\n')}`
  }

  // Per-media-type prompt builders. The user message carries the actual
  // image (image rows only) so Claude Vision can read it; for video
  // rows with a transcript we bake the transcript into the system
  // prompt directly. Silent / sound-effect-only videos fall through to
  // the visual-only path further below which sends sampled keyframes
  // to Claude Vision in the user message.
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
4. "caption" - An engaging social media caption to post with this video. Match the brand voice. ${CAPTION_LENGTH_RULE}
5. "hashtags" - AT MOST 5 total. Include any core brand hashtags from the brand bible first, then topic-specific ones up to the 5-tag limit.
6. "first_comment" - An engagement-driving first comment (question or call to action)

RULES:
- NEVER use em dashes (—). Use commas, periods, or colons instead.
- Match the brand voice and tone from the brand bible
- Make the caption punchy and engaging
- The title should be curiosity-driven, not generic
- ${TRUTH_RULE}

Return ONLY valid JSON:
{"title": "...", "hook": "...", "full_script": "...", "caption": "...", "hashtags": "...", "first_comment": "..."}`

  // Hybrid video prompt — used whenever we can sample frames from the
  // video URL, which is almost always. Why hybrid by default: on-screen
  // text ("POV:", "Wait for it...", product labels, prices, location
  // markers) is invisible to audio transcription but is often THE
  // headline of the video. Background music with lyrics can also fool
  // Scribe into transcribing irrelevant words. Hybrid gives Claude both
  // the spoken transcript AND the visual signal so it can ground the
  // caption in what's actually shown, not just what was spoken.
  //
  // Output shape matches the transcript-only videoSystemPrompt exactly
  // so the row-patching code downstream stays identical.
  const videoHybridSystemPrompt = (transcript, frameCount, durationSecs) => `You are a social media content creator writing a caption for a video. The FRAMES are your primary source of truth: caption what is actually shown on screen.

I am giving you two signals, and they are NOT equal:
  - ${frameCount} KEYFRAMES sampled evenly${durationSecs ? ` across the ${Math.round(durationSecs)}-second clip` : ''} — what is on screen, INCLUDING any text burned into the video. THIS is what the caption is about.
  - An AUDIO TRANSCRIPT — a LOW-priority hint only, and often misleading (see below).

HOW TO USE THE AUDIO: the sound on these videos is usually just a background music track, so the transcript is frequently nothing more than the SONG LYRICS. Song lyrics are NOT what the video is about. IGNORE the transcript entirely unless it is clearly a real person narrating about the subject on screen (the food, the product, the place, the offer, the drink). If you are unsure whether it is narration or a song, ignore it and caption from the frames alone. Never describe, quote, or theme the caption around the background music.

READ THE FRAMES: look closely at what is shown (the actual dish, drink, product, or scene) and at any on-screen text ("POV:", "Wait for it...", price tags, dish names, product labels, location captions). On-screen text is usually the real headline. Quote it directly when it makes a strong title or caption hook.

TODAY'S DATE: ${today}

BRAND CONTEXT:
${brandContext}

AUDIO TRANSCRIPT (low priority, likely just background-music lyrics — ignore it unless it is clearly spoken narration about what is on screen):
${String(transcript || '').slice(0, 8000) || '(no spoken audio detected)'}

Generate the following:
1. "title" - A short, click-worthy, engaging title for this video (max 12 words). Reflect the frames and any on-screen text, not the song.
2. "hook" - The opening 1-2 sentences that hook viewers, based on what is shown.
3. "full_script" - A brief description of what unfolds visually across the frames, in order. Do NOT paste song lyrics here.
4. "caption" - Engaging social caption anchored ENTIRELY to what is shown in the frames and the brand voice. ${CAPTION_LENGTH_RULE}
5. "hashtags" - AT MOST 5 total. Core brand hashtags first, then ones specific to what's shown, up to the 5-tag limit.
6. "first_comment" - Engagement-driving first comment (question or CTA).

RULES:
- Caption from what you SEE, not what you hear. Never reference or theme the caption around the background song or its lyrics.
- Name what is actually on screen specifically (the exact dish, drink, or product), not generic "food" or "this."
- NEVER use em dashes (—). Use commas, periods, or colons.
- Match the brand voice from the brand bible.
- Make the title curiosity-driven, not generic.
- ${TRUTH_RULE}

Return ONLY valid JSON:
{"title": "...", "hook": "...", "full_script": "...", "caption": "...", "hashtags": "...", "first_comment": "..."}`

  // Visual-only prompt — used only when we have keyframes but no usable
  // transcript at all. Same JSON shape as the hybrid + transcript prompts.
  const videoVisualSystemPrompt = (frameCount, durationSecs) => `You are a social media content creator. The video below has no usable spoken audio (it may be silent B-roll, music-only, or driven by sound effects). I'm showing you ${frameCount} keyframes${durationSecs ? ` sampled evenly across the ${Math.round(durationSecs)}-second clip` : ''}. Treat them as a sequence and describe what is happening visually. Pay close attention to any on-screen text burned into the frames (POV hooks, captions, prices, labels) — it is usually the primary message.

TODAY'S DATE: ${today}

BRAND CONTEXT:
${brandContext}

Generate the following:
1. "title" - A short, click-worthy, engaging title for this video (max 12 words). Reference what you actually see.
2. "hook" - The opening 1-2 sentences that hook viewers based on the visual story.
3. "full_script" - A brief description of what unfolds visually across the frames, in order.
4. "caption" - An engaging social media caption to post with this video. Match the brand voice. Anchor it to what is shown. ${CAPTION_LENGTH_RULE}
5. "hashtags" - AT MOST 5 total. Include any core brand hashtags from the brand bible first, then topic-specific ones drawn from what's visible, up to the 5-tag limit.
6. "first_comment" - An engagement-driving first comment (question or call to action).

RULES:
- NEVER use em dashes. Use commas, periods, or colons instead.
- Match the brand voice and tone from the brand bible.
- Only reference things visible in the frames. Do not invent dialogue.
- Name what is actually on screen specifically (the exact dish, drink, or product), not generic "food" or "this."
- Never reference any background music or song.
- The title should be curiosity-driven, not generic.
- ${TRUTH_RULE}

Return ONLY valid JSON:
{"title": "...", "hook": "...", "full_script": "...", "caption": "...", "hashtags": "...", "first_comment": "..."}`

  const imageSystemPrompt = `You are a social media content creator. Look at this image and the brand context below, then generate content for posting this image on social media.

TODAY'S DATE: ${today}

BRAND CONTEXT:
${brandContext}

Generate the following:
1. "title" - A short, click-worthy title for this image (max 10 words)
2. "caption" - An engaging social media caption that complements the image. Match the brand voice. ${CAPTION_LENGTH_RULE}
3. "hashtags" - AT MOST 5 total. Include any core brand hashtags from the brand bible first, then image/topic-specific ones up to the 5-tag limit.
4. "first_comment" - An engagement-driving first comment (question or CTA)

RULES:
- NEVER use em dashes (—). Use commas, periods, or colons instead.
- Match the brand voice and tone from the brand bible
- Reference what's actually visible in the image
- Caption should drive engagement (question, story, or CTA)
- ${TRUTH_RULE}

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
      const transcript = (s.full_script || '').trim()
      const transcriptUsable = transcript.length >= 30
      // Only trust a transcript that reads like real narration. A song's
      // lyrics (which Scribe returns for music-backed B-roll) score false
      // here, so when we also have frames we skip the transcript and caption
      // visually, exactly how a human would.
      const transcriptIsNarration = transcriptUsable && looksLikeNarration(transcript)
      const videoUrl = Array.isArray(s.media_urls) ? s.media_urls[0] : null
      const canSampleFrames = videoUrl && /^https?:\/\//.test(videoUrl)

      // Hybrid by default: sample keyframes whenever we can, regardless
      // of transcript. On-screen text (POV hooks, prices, product
      // labels) is invisible to Scribe but is often the actual
      // headline of the video, so we want Claude to see it every time.
      let frames = null
      let durationSecs = null
      if (canSampleFrames) {
        try {
          const sample = await extractFramesFromUrl(videoUrl, { count: 6, profileId: profile_id })
          if (sample?.frames?.length) {
            frames = sample.frames
            durationSecs = sample.duration_secs
          }
        } catch (e) {
          console.warn(`[generate-captions] frame extract failed for ${s.id}:`, e?.message)
        }
      }

      // If we got nothing on either signal, bail with the legacy
      // sentinel so the UI surfaces "needs manual caption."
      if (!transcriptUsable && !frames) {
        return { _no_transcript: true, _visual_fallback_attempted: canSampleFrames }
      }

      // Pick the prompt + message shape based on which signals we have.
      let systemPrompt
      let messageContent
      let captionSource
      if (frames && transcriptIsNarration) {
        systemPrompt = videoHybridSystemPrompt(transcript, frames.length, durationSecs)
        messageContent = [
          ...framesToVisionBlocks(frames),
          { type: 'text', text: 'The keyframes are the source of truth. Read any on-screen text in them, use the transcript only if it is real spoken narration (not song lyrics), and generate the JSON now.' },
        ]
        captionSource = 'hybrid'
      } else if (frames) {
        // Frames but no usable narration (silent B-roll, or a music-only
        // clip whose transcript is just song lyrics we deliberately dropped).
        systemPrompt = videoVisualSystemPrompt(frames.length, durationSecs)
        messageContent = [
          ...framesToVisionBlocks(frames),
          { type: 'text', text: 'Analyze these keyframes as a sequence and generate the JSON now.' },
        ]
        captionSource = transcriptUsable ? 'visual_music_gated' : 'visual'
      } else {
        systemPrompt = videoSystemPrompt(transcript)
        messageContent = 'Generate the JSON now.'
        captionSource = 'transcript'
      }

      try {
        const ai = await message({
          system: systemPrompt,
          messages: [{ role: 'user', content: messageContent }],
          max_tokens: 1500,
        })
        const parsed = parseJsonObject(ai?.content?.[0]?.text)
        if (!parsed) return null
        return { ...parsed, _caption_source: captionSource }
      } catch (e) {
        console.warn(`[generate-captions] video Claude failed for ${s.id} (${captionSource}):`, e?.message)
        return { _error: e?.data?.error?.message || e?.message || 'AI request failed', _status: e?.status || null }
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
        return { _error: e?.data?.error?.message || e?.message || 'AI request failed', _status: e?.status || null }
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
  // Rows that were already scheduled BEFORE this regen — keep their
  // status as scheduled, then push the new caption to Upload-Post via
  // a resync at the end. Without this branch, regen would downgrade
  // every scheduled row back to caption_ready, leaving the Upload-Post
  // job firing with the stale text and forcing the user to manually
  // re-schedule.
  const needsUploadPostResync = []
  // AI-call failures (e.g. a 401 from an invalid ANTHROPIC_API_KEY). Collected
  // so we can surface them loudly instead of returning a misleading updated:0.
  const aiErrors = []
  const results = await Promise.allSettled(captionResults.map((r, i) => {
    const script = scripts[i]
    if (!script || !r) return Promise.resolve({ ok: false })
    if (r._error) {
      aiErrors.push({ id: script.id, error: r._error, status: r._status || null })
      return Promise.resolve({ ok: false, error: r._error })
    }
    if (r._no_transcript) {
      transcriptFailures.push({ id: script.id, reason: 'no_speech_detected' })
      return Promise.resolve({ ok: false, skipped: 'no_transcript' })
    }
    const wasScheduled = script.status === 'scheduled'
    const wasPosted = script.status === 'posted'
    const patch = {
      caption: applyCreditLine(r.caption || null),
      hashtags: capHashtags(r.hashtags),
      first_comment: r.first_comment || null,
      // Preserve terminal / mid-flight statuses. Only fresh rows
      // (draft / null / failed) flip to caption_ready.
      status: wasPosted ? 'posted' : (wasScheduled ? 'scheduled' : 'caption_ready'),
    }
    if (r.title) patch.title = r.title
    if (r.hook) patch.hook = r.hook
    if (r.full_script) patch.full_script = r.full_script
    if (wasScheduled && (script.uploadpost_request_id || script.uploadpost_job_id)) {
      needsUploadPostResync.push(script.id)
    }
    return supaFetch(`content_scripts?id=eq.${script.id}`, { method: 'PATCH', body: patch, prefer: 'return=minimal' })
      .then(() => ({ ok: true }))
      .catch((e) => { console.warn('caption patch failed for', script.id, e.message); return { ok: false } })
  }))
  const updated = results.filter((r) => r.status === 'fulfilled' && r.value?.ok).length

  // Nothing captioned AND the failures were AI-call errors (not missing
  // transcripts): surface it loudly. Before this, a 401 from an invalid
  // ANTHROPIC_API_KEY was swallowed to null and the UI just showed
  // "nothing happened" with no way to tell why. No credits are consumed
  // on this path (the consume below is gated on updated > 0).
  if (updated === 0 && aiErrors.length > 0) {
    const first = aiErrors[0]
    const isAuth = first.status === 401 || /x-api-key|authentication/i.test(String(first.error || ''))
    return res.status(502).json({
      error: isAuth
        ? 'Caption generation failed: the AI service rejected the request (authentication). The ANTHROPIC_API_KEY is likely invalid or expired.'
        : `Caption generation failed: ${first.error}`,
      code: isAuth ? 'ai_auth_error' : 'ai_error',
      ai_status: first.status || null,
      updated: 0,
      total: scripts.length,
    })
  }

  // Push the new caption to Upload-Post for every scheduled row we
  // just refreshed. Reuses the existing resync flow which cancels the
  // old Upload-Post job + resubmits with the row's CURRENT (newly
  // regenerated) caption + hashtags + first_comment.
  let uploadPostResynced = 0
  let uploadPostResyncFailed = 0
  if (needsUploadPostResync.length) {
    try {
      // Stub the response collector so resyncUploadPost can write
      // status / json without affecting the live `res`.
      const stubRes = { _status: 200, _body: null, status(c) { this._status = c; return this }, json(b) { this._body = b; return this } }
      await resyncUploadPost({ req: { headers: {} }, res: stubRes, profile_id, script_ids: needsUploadPostResync })
      uploadPostResynced = stubRes._body?.resynced ?? 0
      uploadPostResyncFailed = stubRes._body?.failed ?? 0
    } catch (e) {
      console.warn('caption-regen resync failed:', e?.message)
    }
  }

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
  const debug = scripts.map((s, i) => {
    const r = captionResults[i]
    let ai_status = 'failed'
    if (r) {
      if (r._no_transcript) ai_status = 'placeholder_no_transcript'
      else if (r._caption_source === 'visual') ai_status = 'ok_visual_fallback'
      else ai_status = 'ok'
    }
    return {
      id: s.id,
      media_type: s.media_type,
      transcript_chars: (s.full_script || '').length,
      transcript_preview: (s.full_script || '').slice(0, 200),
      caption_source: r?._caption_source || (r?._no_transcript ? null : 'transcript'),
      ai_status,
    }
  })
  return res.status(200).json({
    updated,
    total: scripts.length,
    // Surface any rows where we couldn't extract a topic signal so the
    // UI can toast "n video(s) couldn't be transcribed — their captions
    // may be generic." Better than silently shipping brand-only captions.
    transcript_failures: transcriptFailures,
    // Already-scheduled rows whose Upload-Post job got refreshed
    // with the new caption. UI can toast "X scheduled posts updated
    // on Upload-Post with new captions."
    upload_post_resynced: uploadPostResynced,
    upload_post_resync_failed: uploadPostResyncFailed,
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

  // Pick up every row that's NOT already in scheduled / posted / failed
  // status. That covers two cases:
  //   1. Brand-new rows with no scheduled_datetime → allocate a slot.
  //   2. Rows that were once scheduled but got knocked back to
  //      caption_ready (e.g. a caption-regen pre-fix flipped status
  //      while keeping the scheduled_datetime). We KEEP their existing
  //      scheduled_datetime instead of pushing them to the back of the
  //      queue, then flip status back to scheduled + push fresh
  //      caption to Upload-Post.
  let q = `content_scripts?profile_id=eq.${profile_id}`
  if (Array.isArray(script_ids) && script_ids.length) {
    q += `&id=in.(${script_ids.map((id) => encodeURIComponent(id)).join(',')})`
  } else {
    q += '&status=in.(caption_ready,draft)'
  }
  // media_urls needed so we can skip text-only rows below. Without
  // this guard, bulk-auto-schedule was the main source of ghost
  // queue entries: it'd parade every caption_ready / draft row into
  // the calendar regardless of whether there was anything to publish.
  q += '&select=id,media_urls,scheduled_datetime&order=scheduled_datetime.asc.nullslast,created_at.asc&limit=200'
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
  // Rows that already have a scheduled_datetime keep it; brand-new
  // rows pick the next open slot.
  const assignments = []
  for (const row of candidates) {
    if (row.scheduled_datetime) {
      assignments.push({ id: row.id, slot: row.scheduled_datetime, kept_existing: true })
      takenSet.add(new Date(row.scheduled_datetime).toISOString())
      continue
    }
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
  // Now: every row (video AND image) is submitted to Upload-Post inline
  // with scheduled_date, the returned request_id is persisted back, and
  // future DELETEs cascade-cancel cleanly. Videos pass through as a URL
  // (async_upload=true); images forward their bytes as multipart parts
  // (Upload-Post doesn't accept URL strings for photos). Any row whose
  // handoff doesn't complete is rolled back out of 'scheduled' so it
  // never becomes a handle-less ghost the sync cron can't see.
  const apiKey = process.env.UPLOADPOST_API_KEY
  let submitted = 0
  let submitFailed = 0
  if (apiKey && assignments.length) {
    const username = await resolveUploadpostUser(profile_id)
    await uploadpostEnsureUserProfile(username).catch(() => {})

    const rowIds = assignments.map((a) => a.id)
    const fullRows = await supaFetch(
      `content_scripts?id=in.(${rowIds.map((id) => encodeURIComponent(id)).join(',')})&select=id,media_urls,media_type,platforms,caption,hashtags,full_script,title,first_comment,cover_image_url,media_url_with_cover,embed_cover_intro`
    ).catch(() => [])
    const rowById = new Map((fullRows || []).map((r) => [r.id, r]))

    // Roll a row back out of the scheduled state when its Upload-Post
    // handoff didn't complete. The upfront PATCH (above) optimistically
    // flips every assigned row to status='scheduled' so the calendar +
    // double-book guard react immediately, but a row that never reached
    // Upload-Post (or came back without a request_id) is a ghost: it
    // shows as scheduled forever yet no job exists and no cron will ever
    // touch it (sync-scheduled-posts only polls rows WHERE
    // uploadpost_request_id IS NOT NULL). Knocking it back to
    // caption_ready — while KEEPING its scheduled_datetime so a retry
    // re-uses the same slot — surfaces the failure instead of hiding it.
    const rollback = async (rowId, errText) => {
      submitFailed++
      await supaFetch(`content_scripts?id=eq.${rowId}`, {
        method: 'PATCH',
        body: {
          status: 'caption_ready',
          last_error: errText ? errText.toString().slice(0, 1000) : 'Upload-Post submission did not complete',
          last_error_at: new Date().toISOString(),
        },
        prefer: 'return=minimal',
      }).catch(() => {})
    }

    const submitOne = async (a) => {
      const row = rowById.get(a.id)
      if (!row) return
      const isVideoRow = row.media_type === 'video'
      const isImageRow = row.media_type === 'image'
      // Anything that isn't a video or image shouldn't have reached here
      // (the media filter up top drops text + media-less rows), but guard
      // anyway: don't leave a non-submittable row sitting as scheduled.
      if (!isVideoRow && !isImageRow) {
        await rollback(row.id, 'Unsupported media_type for auto-schedule submission')
        return
      }

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

      try {
        let upRes
        if (isVideoRow) {
          // ── VIDEO: URL pass-through. ──────────────────────────────────
          // Pick the cover-embedded URL when the user opted in and we
          // already generated it. IG still gets its native
          // instagram_cover_url for the Reel thumbnail.
          const mediaUrl = (row.embed_cover_intro !== false && row.media_url_with_cover)
            ? row.media_url_with_cover
            : row.media_urls?.[0]
          if (!mediaUrl) { await rollback(row.id, 'No media URL on row'); return }

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

          upRes = await fetch('https://api.upload-post.com/api/upload', {
            method: 'POST',
            headers: { Authorization: `Apikey ${apiKey}` },
            body: form,
          })
        } else {
          // ── IMAGE: bytes multipart to /upload_photos. ─────────────────
          // Upload-Post's photo endpoint does NOT accept URL strings —
          // the bytes have to be fetched and forwarded as file parts
          // (mirrors publishSelected's photo branch). Previously this
          // path early-returned, which is exactly what stranded
          // auto-scheduled image rows as scheduled-but-never-queued
          // ghosts. They now submit inline like videos, with the same
          // scheduled_date so Upload-Post fires them at the slot time.
          const photoUrls = Array.isArray(row.media_urls) ? row.media_urls.filter(Boolean) : []
          if (!photoUrls.length) { await rollback(row.id, 'No media URL on row'); return }

          const fd = new FormData()
          fd.append('user', username)
          for (const p of platforms) fd.append('platform[]', p)
          if (desc) fd.append('description', desc)
          fd.append('title', cleanTitle.slice(0, 100))
          if (platforms.includes('youtube')) fd.append('youtube_title', cleanTitle.slice(0, 100))
          if (hasTikTok && desc) {
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
          if (row.first_comment) fd.append('first_comment', String(row.first_comment).slice(0, 2200))
          fd.append('async_upload', 'true')
          fd.append('scheduled_date', new Date(a.slot).toISOString())

          for (let i = 0; i < photoUrls.length; i++) {
            const url = photoUrls[i]
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
          const errText = (body?.error || body?.message || `Upload-Post ${upRes.status}`).toString().slice(0, 1000)
          console.warn(`auto-schedule submit failed for ${row.id}:`, errText)
          await rollback(row.id, `[${upRes.status}] ${errText}`)
          return
        }
        const requestId = body?.request_id || body?.id || null
        if (!requestId) {
          // Upload-Post returned 2xx but gave us no handle — without a
          // request_id the sync cron can never confirm or fail this row,
          // so treat it as a non-completion and roll back rather than
          // leaving a handle-less scheduled ghost.
          console.warn(`auto-schedule: no request_id returned for ${row.id}`, body)
          await rollback(row.id, 'Upload-Post returned no request_id')
          return
        }
        await supaFetch(`content_scripts?id=eq.${row.id}`, {
          method: 'PATCH',
          body: { uploadpost_request_id: requestId, last_error: null, last_error_at: null },
          prefer: 'return=minimal',
        }).catch(() => {})
        submitted++
      } catch (e) {
        console.warn(`auto-schedule submit threw for ${row.id}:`, e?.message)
        await rollback(row.id, e?.message || 'submission threw')
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

  // When the Upload-Post handoff ran (apiKey present), the only rows that
  // truly stayed scheduled are the ones that got a request_id — failures
  // were rolled back to caption_ready. Report that as the scheduled count
  // so the UI doesn't claim posts are queued when they were knocked back.
  // With no apiKey (dev / misconfig) nothing was submitted, so fall back
  // to the optimistic slot-assignment count.
  const effectiveScheduled = apiKey ? submitted : scheduled
  return res.status(200).json({
    scheduled: effectiveScheduled,
    submitted,
    submit_failed: submitFailed,
    skipped: candidates.length - effectiveScheduled,
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

  // Per-brand TikTok Draft mode: publish-now must honor it too (this path
  // builds its own Upload-Post request, separate from /api/social/upload-post).
  let tiktokDraftMode = false
  try {
    const pr = await supaFetch(`profiles?id=eq.${profile_id}&select=tiktok_draft_mode`)
    tiktokDraftMode = !!pr?.[0]?.tiktok_draft_mode
  } catch { /* default direct post */ }

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
      // Idempotency guard — never re-publish a row that already went
      // out. Root-caused from a real incident: a posted row got
      // re-submitted 4 extra times within 3 minutes (platform-grouped
      // pseudo-rows in the UI each triggered a full-platform publish),
      // landing the same TikTok video 5x. status='posted' is the
      // authoritative "this fired" signal, so publish requests for
      // those rows are now no-ops. Re-publishing intentionally (rare)
      // means flipping status back first via the row editor.
      if (r.status === 'posted') {
        results.push({ id: r.id, ok: false, skipped: true, error: 'already posted — skipped (flip status to re-publish intentionally)' })
        continue
      }
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
        // Draft mode → send to TikTok inbox/drafts instead of the feed.
        // Per-post override (r.tiktok_direct_override) beats the brand flag.
        if (hasTikTok && (r.tiktok_direct_override === false || (tiktokDraftMode && r.tiktok_direct_override !== true))) form.append('post_mode', 'MEDIA_UPLOAD')
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
        // Prefer the cover-embedded video when set + opt-in is on, so
        // platforms that auto-thumbnail from frame 0 (TikTok / YouTube
        // / FB / Threads) see the cover as the start frame. IG still
        // gets instagram_cover_url separately for its native cover.
        const submitVideoUrl = (r.embed_cover_intro !== false && r.media_url_with_cover)
          ? r.media_url_with_cover
          : r.media_urls[0]
        form.append('video', submitVideoUrl)

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
        // Draft mode → send to TikTok inbox/drafts instead of the feed.
        // Per-post override (r.tiktok_direct_override) beats the brand flag.
        if (hasTikTok && (r.tiktok_direct_override === false || (tiktokDraftMode && r.tiktok_direct_override !== true))) fd.append('post_mode', 'MEDIA_UPLOAD')
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
          // TikTok photo mode rejects PNG + oversized images. Normalize to a
          // JPEG within 1080x1920 for TikTok (their real photo cap); other platforms take originals.
          if (hasTikTok) {
            try {
              const jpeg = await sharp(Buffer.from(ab))
                .rotate()
                .resize({ width: 1080, height: 1920, fit: 'inside', withoutEnlargement: true })
                .jpeg({ quality: 90 })
                .toBuffer()
              fd.append('photos[]', new Blob([jpeg], { type: 'image/jpeg' }), `image_${i + 1}.jpg`)
              continue
            } catch (e) {
              console.warn(`[tiktok-photo] JPEG convert failed for ${url} (${e?.message}); sending original`)
            }
          }
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
  q += '&select=id,title,full_script,caption,hashtags,first_comment,media_urls,media_type,platforms,scheduled_datetime,uploadpost_request_id,cover_image_url,media_url_with_cover,embed_cover_intro'
  const rows = await supaFetch(q)
  if (!rows?.length) return res.status(200).json({ resynced: 0, skipped: 0, failed: 0, details: [] })

  // In-process invoke instead of self-fetching the public URL. Same
  // Vercel-preview SSO-wall problem the reschedule path hit: a server-
  // to-server fetch to our own host gets 401'd by Deployment Protection.
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
    // Cover-embedded video preferred when toggled + available.
    const videoToSend = isVideo
      ? ((row.embed_cover_intro !== false && row.media_url_with_cover) ? row.media_url_with_cover : mediaUrls[0])
      : undefined
    const body = {
      profile_id,
      platforms,
      video_url: videoToSend,
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
      const captured = await invokeHandler(uploadPostHandler, req, { method: 'POST', body })
      const resp = captured.body || {}
      if (captured.statusCode < 200 || captured.statusCode >= 300) {
        failed += 1
        details.push({ id: row.id, status: 'failed', reason: resp?.error || `upload-post ${captured.statusCode}` })
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
