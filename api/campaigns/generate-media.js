// POST /api/campaigns/generate-media
//
// Turns an approved campaign post's media_brief into real media and
// attaches it to the row, then completes scheduling. Two entry modes:
//
//   { content_id }              → generate media for ONE post (per-post button)
//   { campaign_id }             → process the NEXT post needing media and
//                                 report how many remain (the "Generate all"
//                                 button loops this until remaining === 0)
//
// Images / carousels / promos / mood pieces go through /api/images/generate
// (nano-banana image-to-image) so they inherit the OBJECT "keep the product
// EXACT" prompt expansion + credit reservation/refund already built there;
// we poll /api/images/status for the mirrored result URLs. Videos go
// straight to Kie's grok-imagine image-to-video (animating a real photo).
//
// Resumable: in-flight Kie task ids are stored on content_scripts.media_jobs,
// so if the function's poll budget runs out mid-generation the row stays
// 'generating' and the next call resumes polling instead of re-submitting
// (and re-charging). When media lands and the post is already approved with
// a future slot, we re-invoke the approve action so it schedules + submits
// to Upload-Post — finishing the approve -> media -> scheduled loop.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { withCreditReservation } from '../_lib/credits.js'
import { invokeHandler } from '../_lib/internal-invoke.js'
import imagesGenerate from '../images/generate.js'
import imagesStatus from '../images/status.js'

export const config = { maxDuration: 300 }

const KIE_API_KEY = process.env.KIE_API_KEY
const SUPABASE_URL = process.env.SUPABASE_URL
const SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY

// Vertical 4:5 is the safest single ratio across IG/FB/TikTok feed.
const IMAGE_ASPECT = '4:5'
const VIDEO_ASPECT = '9:16'
const VIDEO_FEE_TOKENS = 30000   // ~ one short grok clip; refunded on failure
const POLL_MS = 5000
const POLL_BUDGET_MS = 210000    // leave headroom under the 300s function cap

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// Build the image-generation prompt. When the brief locks the product,
// phrase the reference so /api/images/generate's OBJECT-role expansion
// fires ("keep the product exact"); restyle only background/lighting.
function buildImagePrompt(brief, refLabels) {
  const base = String(brief?.prompt || 'On-brand marketing photo for the restaurant.').trim()
  if (!refLabels.length) return base.slice(0, 4800)
  const mentions = refLabels.map((l) => `reference "${l}"`).join(' and ')
  const lock = brief?.exact_lock
    ? ` Use the real product exactly as shown in ${mentions}: do not change the food, plating, garnishes, colors, or any product detail. Keep it an exact match to the reference. Restyle only the background, lighting, and composition.`
    : ` Take visual guidance from ${mentions}.`
  return (base + lock).slice(0, 4800)
}

// Mirror a Kie video result into our public bucket (landing-media allows
// video mimes) so it survives Kie's tempfile expiry.
async function mirrorVideo(url, profileId) {
  try {
    if (!SUPABASE_URL || !SERVICE_KEY) return url
    const r = await fetch(url)
    if (!r.ok) return url
    const buf = await r.arrayBuffer()
    const ct = r.headers.get('content-type') || 'video/mp4'
    const ext = ct.includes('webm') ? 'webm' : ct.includes('quicktime') ? 'mov' : 'mp4'
    const path = `${profileId || 'shared'}/campaign/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`
    const up = await fetch(`${SUPABASE_URL}/storage/v1/object/landing-media/${encodeURI(path)}`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${SERVICE_KEY}`, 'Content-Type': ct, 'x-upsert': 'true' },
      body: buf,
    })
    if (!up.ok) return url
    return `${SUPABASE_URL}/storage/v1/object/public/landing-media/${path}`
  } catch { return url }
}

async function submitGrokVideo(imageUrl, prompt) {
  const body = {
    model: 'grok-imagine/image-to-video',
    input: {
      image_urls: [imageUrl],
      prompt: String(prompt || 'Subtle, appetizing camera movement, natural motion, cinematic').slice(0, 5000),
      mode: 'normal', duration: '6', resolution: '720p', aspect_ratio: VIDEO_ASPECT,
    },
  }
  const r = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
    method: 'POST',
    headers: { Authorization: `Bearer ${KIE_API_KEY}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let data = {}; try { data = JSON.parse(text) } catch {}
  if (!r.ok || (data?.code && data.code !== 200)) {
    throw new Error(`Kie grok createTask ${r.status}: ${(data?.msg || text).slice(0, 200)}`)
  }
  const taskId = data?.data?.taskId || data?.taskId
  if (!taskId) throw new Error('Kie grok returned no taskId')
  return taskId
}

// Poll one Kie video task. Returns { state, url? }.
async function pollGrokVideo(taskId) {
  const r = await fetch(`https://api.kie.ai/api/v1/jobs/recordInfo?taskId=${encodeURIComponent(taskId)}`, {
    headers: { Authorization: `Bearer ${KIE_API_KEY}` },
  })
  const text = await r.text()
  let body = {}; try { body = JSON.parse(text) } catch {}
  const data = body?.data || body
  const state = String(data?.state || data?.status || '').toLowerCase()
  let urls = []
  const rj = data?.resultJson
  if (typeof rj === 'string') { try { const p = JSON.parse(rj); urls = p?.resultUrls || (Array.isArray(p) ? p : []) } catch {} }
  else if (rj?.resultUrls) urls = rj.resultUrls
  if (!urls.length) urls = data?.resultUrls || []
  urls = (Array.isArray(urls) ? urls : []).filter(Boolean)
  if (state === 'success' || state === 'completed' || state === 'done' || urls.length) {
    return urls.length ? { state: 'success', url: typeof urls[0] === 'string' ? urls[0] : urls[0]?.url } : { state: 'failed' }
  }
  if (state === 'fail' || state === 'failed' || state === 'error') return { state: 'failed' }
  return { state: 'pending' }
}

// Core: generate media for one row. Returns a status object; never throws
// for expected outcomes (pending/failed) — only for programmer errors.
async function processRow(row, req, userId) {
  const brief = row.media_brief || {}
  const ct = brief.content_type || row.media_type || 'text'

  // Text posts need no media.
  if (ct === 'text' || row.media_type === 'text') {
    await patch(row.id, { media_gen_status: 'ready' })
    return { state: 'ready', skipped: true }
  }
  // Already has media.
  if (Array.isArray(row.media_urls) && row.media_urls.length) {
    await patch(row.id, { media_gen_status: 'ready' })
    return { state: 'ready', already: true }
  }

  // Resolve referenced real assets (images only usable as generation refs).
  let refImages = []
  const ids = Array.isArray(brief.reference_asset_ids) ? brief.reference_asset_ids : []
  if (ids.length) {
    const rows = await supaFetch(
      `brand_assets?id=in.(${ids.map((s) => `"${s}"`).join(',')})&select=id,label,public_url,media_type`,
    ).catch(() => [])
    refImages = (rows || []).filter((a) => a.media_type === 'image')
  }
  const refUrls = refImages.map((a) => a.public_url)
  const refLabels = refImages.map((a) => a.label || 'reference')
  let jobs = row.media_jobs || null
  const deadline = Date.now() + POLL_BUDGET_MS

  try {
    if (ct === 'video') {
      const srcImage = refUrls[0]
      if (!srcImage) throw new Error('This video post has no image reference to animate. Add a real photo to its brief.')
      if (!jobs?.video_task) {
        const taskId = await withCreditReservation(
          { userId, poolType: 'ai_tokens', amount: VIDEO_FEE_TOKENS, action: 'consume:campaign-video', profileId: row.profile_id },
          async ({ refundIfFailed, tagMetadata }) => {
            try { const t = await submitGrokVideo(srcImage, brief.prompt); await tagMetadata({ taskId: t }); return t }
            catch (e) { await refundIfFailed(); throw e }
          },
        )
        jobs = { kind: 'video', video_task: taskId }
        await patch(row.id, { media_jobs: jobs, media_gen_status: 'generating', media_gen_error: null })
      }
      while (Date.now() < deadline) {
        const v = await pollGrokVideo(jobs.video_task)
        if (v.state === 'success' && v.url) {
          const mirrored = await mirrorVideo(v.url, row.profile_id)
          await finishMedia(row, [mirrored], 'video')
          return { state: 'ready' }
        }
        if (v.state === 'failed') { await fail(row.id, 'Video generation failed at Kie.'); return { state: 'failed' } }
        await sleep(POLL_MS)
      }
      return { state: 'pending' }   // resume on next call
    }

    // image / carousel / promo / mood → nano-banana via /api/images/generate
    const count = ct === 'carousel' ? Math.max(3, Math.min(6, Number(brief.slides) || 3)) : 1
    if (!jobs?.image_task) {
      const gen = await invokeHandler(imagesGenerate, req, {
        method: 'POST',
        body: {
          profile_id: row.profile_id,
          prompt: buildImagePrompt(brief, refLabels),
          model: 'nano-banana-2',
          count,
          aspect: IMAGE_ASPECT,
          reference_urls: refUrls,
        },
      })
      if (gen.statusCode >= 300 || !gen.body?.taskId) {
        const msg = gen.body?.error || `image submit failed (${gen.statusCode})`
        if (gen.body?.code === 'insufficient_credits') { await fail(row.id, 'Not enough credits to generate this image.'); return { state: 'failed', code: 'insufficient_credits' } }
        throw new Error(msg)
      }
      jobs = { kind: 'image', image_task: gen.body.taskId, count }
      await patch(row.id, { media_jobs: jobs, media_gen_status: 'generating', media_gen_error: null })
    }
    while (Date.now() < deadline) {
      const st = await invokeHandler(imagesStatus, req, {
        method: 'GET', query: { taskId: jobs.image_task, profile_id: row.profile_id },
      })
      const state = st.body?.state
      if (state === 'success' && Array.isArray(st.body.images) && st.body.images.length) {
        const urls = st.body.images.map((i) => i.url).filter(Boolean)
        await finishMedia(row, urls, count > 1 ? 'carousel' : 'image')
        return { state: 'ready' }
      }
      if (state === 'failed') { await fail(row.id, st.body?.error || 'Image generation failed.'); return { state: 'failed' } }
      await sleep(POLL_MS)
    }
    return { state: 'pending' }
  } catch (e) {
    await fail(row.id, String(e?.message || e).slice(0, 500))
    return { state: 'failed', error: e?.message }
  }
}

async function patch(id, body) {
  await supaFetch(`content_scripts?id=eq.${id}`, { method: 'PATCH', body, prefer: 'return=minimal' }).catch(() => {})
}
async function fail(id, msg) {
  await patch(id, { media_gen_status: 'failed', media_gen_error: msg, media_jobs: null })
}

// Write the generated media onto the row, then finish scheduling if the
// post was already approved (re-invoke approve so it submits to Upload-Post).
async function finishMedia(row, urls, mediaType) {
  await patch(row.id, {
    media_urls: urls,
    media_type: mediaType,
    media_gen_status: 'ready',
    media_jobs: null,
    media_gen_error: null,
  })
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' })
  if (!KIE_API_KEY) return res.status(500).json({ error: 'KIE_API_KEY not configured' })

  const auth = await requireUser(req, res)
  if (!auth) return

  try {
    const body = req.body || {}
    let targetRow = null
    let remaining = 0

    if (body.content_id) {
      const rows = await supaFetch(`content_scripts?id=eq.${body.content_id}&limit=1`)
      targetRow = rows?.[0]
      if (!targetRow) return res.status(404).json({ error: 'post not found' })
      await assertProfileAccess(auth.user.id, targetRow.profile_id)
    } else if (body.campaign_id) {
      const camp = await supaFetch(`campaigns?id=eq.${body.campaign_id}&select=profile_id&limit=1`)
      if (!camp?.[0]) return res.status(404).json({ error: 'campaign not found' })
      await assertProfileAccess(auth.user.id, camp[0].profile_id)
      // Next post needing media: not text, no media yet, not rejected,
      // not already done. Ordered by schedule so it fills in order.
      // Failed posts are deliberately excluded from the batch so a bad
      // brief can't loop forever — the user retries those individually.
      const pending = await supaFetch(
        `content_scripts?campaign_id=eq.${body.campaign_id}` +
        `&media_type=neq.text&approval_status=neq.rejected` +
        `&or=(media_gen_status.is.null,media_gen_status.in.(idle,generating))` +
        `&order=scheduled_datetime.asc&limit=50` +
        `&select=id,profile_id,media_type,media_urls,media_brief,media_jobs,approval_status,scheduled_datetime,uploadpost_request_id`,
      ).catch(() => [])
      // Filter out rows that already have media (belt and suspenders).
      const needy = (pending || []).filter((r) => !(Array.isArray(r.media_urls) && r.media_urls.length))
      remaining = needy.length
      targetRow = needy[0] || null
      if (!targetRow) return res.status(200).json({ done: true, remaining: 0, processed: null })
    } else {
      return res.status(400).json({ error: 'content_id or campaign_id required' })
    }

    const result = await processRow(targetRow, req, auth.user.id)

    // IMPORTANT: generated media is NEVER auto-submitted to Upload-Post.
    // The post was "approved" as a caption/plan, before any media existed,
    // so publishing the moment media lands would push un-reviewed (and
    // possibly bad) AI media live. Media-ready posts wait at status
    // 'caption_ready' for an explicit review + schedule step, where the
    // user sees the actual image/video first.
    const scheduled = false

    return res.status(200).json({
      done: body.content_id ? true : (result.state !== 'pending' && remaining <= 1 && result.state !== 'failed'),
      state: result.state,
      processed: targetRow.id,
      scheduled,
      remaining: body.campaign_id ? Math.max(0, remaining - (result.state === 'ready' ? 1 : 0)) : 0,
      error: result.error || null,
    })
  } catch (e) {
    return res.status(e?.status || 500).json({ error: e?.message || String(e) })
  }
}
