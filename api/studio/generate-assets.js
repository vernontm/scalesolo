// POST /api/studio/generate-assets — kick off asset generation for an approved
// video map. Fans out per-segment jobs to ElevenLabs (voice), Kie.ai (B-roll
// images), and HeyGen (avatar lip-sync) in parallel and updates segment rows
// as each completes (or kicks off async polling via task ids).
//
// Three job classes per segment:
//
//   Voice  — every segment with script_text. Synchronous: we get the mp3 bytes
//            back in-line, upload to Supabase storage, fill voice_url. Studio
//            needs the audio to drive segment duration and to lip-sync HeyGen.
//
//   Image  — voiceover_broll only. Async via Kie.ai's createTask + recordInfo
//            pattern. We submit, store kie_task_id, and let the poller pick
//            up the URL when ready.
//
//   Avatar — avatar segments only. Requires voice_url to already exist (we
//            lip-sync the HeyGen avatar to our ElevenLabs audio so we get
//            ElevenLabs voice quality + HeyGen face motion). We submit
//            HeyGen V3 with audio_url, store heygen_video_id, poller picks
//            up video_url when ready.
//
// Skipped segments (approved=false or pure_motion_graphics) get marked
// status='ready' immediately — pure motion graphics needs no pre-render
// assets; the HyperFrames bake handles their visuals at task #10.
//
// This endpoint is idempotent: calling it again on the same video is safe
// (re-runs failed segments, leaves successful ones alone unless force=1).

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { gateStudio } from './_lib/gate.js'
import { customerIdForUser } from '../_lib/credits.js'

// Credit gate. Returns null on success, or a 402 payload to send back.
// Mirrors the cost estimator's HIGH-bound math from estimate-cost.js
// so the gate matches the UI display exactly.
async function checkCredits(userId, video) {
  const customerId = await customerIdForUser(userId)
  if (!customerId) {
    // No billing customer yet → free trial / pre-checkout. Block to
    // force users into a paid tier before they burn provider quotas
    // we can't recover from.
    return { error: 'No active subscription. Start a plan to generate Studio renders.', code: 'no_subscription' }
  }
  const duration = Number(video.target_duration_secs) || 120
  const hasAvatar = !!video.avatar_id
  const avatarSecs = hasAvatar ? Math.round(duration * 0.65) : 0

  const needAiTokens     = Math.ceil(20000 + 14000 + 9000 + 3 * 3500)   // HIGH bound
  const needVideoUnits   = Math.ceil(avatarSecs * 1.15 / 6.7)
  const needVoiceMinutes = Number((duration * 1.10 / 60).toFixed(2))

  const pools = await supaFetch(
    `credit_pools?customer_id=eq.${customerId}&select=pool_type,balance`,
  )
  const bal = { ai_tokens: 0, video_units: 0, voice_minutes: 0 }
  for (const p of (pools || [])) {
    if (p.pool_type in bal) bal[p.pool_type] = Number(p.balance) || 0
  }

  const short = []
  if (bal.ai_tokens     < needAiTokens)     short.push(`ai_tokens (need ${needAiTokens}, have ${bal.ai_tokens})`)
  if (needVideoUnits > 0 && bal.video_units < needVideoUnits)
    short.push(`video_units (need ${needVideoUnits}, have ${bal.video_units})`)
  if (bal.voice_minutes < needVoiceMinutes) short.push(`voice_minutes (need ${needVoiceMinutes}, have ${bal.voice_minutes})`)

  if (short.length) {
    return {
      error: `Insufficient credits: ${short.join(', ')}. Top up or shorten the video.`,
      code: 'insufficient_credits',
    }
  }
  return null
}
import { synthesizeToPublicUrl } from '../_lib/elevenlabs.js'
import { generateVideoV3, listLooksForGroup } from '../_lib/heygen.js'

export const config = {
  maxDuration: 300,
  memory: 1024,
}

// Each segment gets its own try/catch so one failure doesn't poison the rest.
async function dispatchVoice(segment, voiceId, profileId) {
  if (!segment.script_text?.trim()) return null
  if (!voiceId) throw new Error('No voice configured on the video')
  const url = await synthesizeToPublicUrl(voiceId, segment.script_text, profileId, {
    // Modest defaults; the brand voice's saved settings live on the avatar/
    // voice library row and aren't piped through Studio yet. v2 of asset gen
    // resolves the voice config from the brand profile.
    model_id: 'eleven_turbo_v2_5',
  })
  return url
}

// Match the input shape api/images/generate.js uses for nano-banana-2. The
// keys here are not what you'd guess from the model name; missing any of
// num_images/resolution/output_format is a silent 400 from Kie.
async function dispatchImage(segment, apiKey, aspectRatio) {
  if (!segment.image_prompt?.trim()) throw new Error('Image prompt is empty')
  // Project aspect ratio → Kie's expected aspect_ratio string. nano-banana-2
  // accepts 16:9 / 9:16 / 1:1 / 'auto'. Pass-through.
  const aspect = ['16:9', '9:16', '1:1'].includes(aspectRatio) ? aspectRatio : 'auto'
  const body = {
    model: 'nano-banana-2',
    input: {
      prompt: segment.image_prompt,
      image_input: [],
      aspect_ratio: aspect,
      resolution: '1K',
      output_format: 'png',
      num_images: 1,
    },
  }
  // 30s timeout — Kie just queues the task; the actual image gen runs
  // async and we poll it separately. The submit call should land in
  // 1-3s; anything over 30s means Kie is wedged.
  const kieController = new AbortController()
  const kieTimeout = setTimeout(() => kieController.abort(), 30_000)
  let submit
  try {
    submit = await fetch('https://api.kie.ai/api/v1/jobs/createTask', {
      method: 'POST',
      signal: kieController.signal,
      headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  } catch (e) {
    if (e?.name === 'AbortError') throw new Error('Kie.ai submit timed out after 30s')
    throw e
  } finally {
    clearTimeout(kieTimeout)
  }
  const text = await submit.text()
  let respBody = {}
  try { respBody = JSON.parse(text) } catch { respBody = { raw: text } }
  if (!submit.ok || (respBody?.code && respBody.code !== 200)) {
    throw new Error(`Kie.ai submit failed (${submit.status}): ${respBody?.msg || respBody?.message || respBody?.error || text.slice(0, 200)}`)
  }
  const taskId = respBody?.data?.taskId || respBody?.data?.task_id || respBody?.taskId
  if (!taskId) throw new Error('Kie.ai returned no taskId')
  return taskId
}

// Resolve the actual HeyGen avatar id to pass on /v3/videos. The video's
// avatar_id column can be one of:
//   • a row id from public.avatars (the common case — custom avatars
//     trained via /api/avatars). The renderable id lives on
//     talking_photo_id.
//   • "pub:<heygen_group_id>" — public library entry. Group ids aren't
//     directly renderable; we list the group's looks and pick the first.
//   • "default:<default_avatar_id>" — system defaults table. Schema has
//     heygen_group_id (not talking_photo_id), so we treat these like pub:
//     and resolve through listLooksForGroup.
async function pickFirstLookFromGroup(groupId) {
  try {
    const looksResp = await listLooksForGroup(groupId)
    const looks = looksResp?.data?.avatar_list || looksResp?.data || []
    const first = Array.isArray(looks) ? looks[0] : null
    return first?.avatar_id || first?.id || first?.avatar_v3_id || null
  } catch {
    return null
  }
}

// lookId (optional): user-picked avatar_looks row. When present, its
// heygen_look_id WINS over the avatar's primary talking_photo_id. This
// is how a user with portrait + landscape variants of the same avatar
// chooses which to render with — pick the look that matches the
// video's aspect ratio.
async function resolveHeygenAvatarId(rawAvatarId, lookId) {
  // Explicit look pick takes priority. We still load the look row even
  // if avatar_id isn't set, since the look has its own heygen_look_id.
  if (lookId) {
    const lkRows = await supaFetch(`avatar_looks?id=eq.${lookId}&select=heygen_look_id&limit=1`).catch(() => [])
    const heygenLookId = lkRows?.[0]?.heygen_look_id
    if (heygenLookId) return heygenLookId
    // Look row exists but no heygen_look_id yet (training failed / not
    // synced). Fall through to the avatar-level resolution rather than
    // erroring — user gets the next-best avatar instead of a hard block.
  }

  if (!rawAvatarId) return null
  if (typeof rawAvatarId === 'string' && rawAvatarId.startsWith('pub:')) {
    const groupId = rawAvatarId.slice(4)
    return (await pickFirstLookFromGroup(groupId)) || groupId
  }
  if (typeof rawAvatarId === 'string' && rawAvatarId.startsWith('default:')) {
    const defId = rawAvatarId.slice('default:'.length)
    const rows = await supaFetch(`default_avatars?id=eq.${defId}&select=heygen_group_id,is_active&limit=1`).catch(() => [])
    const groupId = rows?.[0]?.heygen_group_id
    if (!groupId) throw new Error(`Default avatar ${defId} has no heygen_group_id`)
    return (await pickFirstLookFromGroup(groupId)) || groupId
  }
  // Custom avatar row in public.avatars. talking_photo_id is the only id
  // HeyGen knows about for this row; heygen_avatar_id doesn't exist on
  // this table.
  const rows = await supaFetch(`avatars?id=eq.${rawAvatarId}&select=talking_photo_id,training_status&limit=1`).catch(() => [])
  const row = rows?.[0]
  if (!row) throw new Error(`Avatar ${rawAvatarId} not found in ScaleSolo's avatars table`)
  if (row.training_status && !['ready', 'completed', 'success'].includes(row.training_status)) {
    throw new Error(`Avatar training is not complete (status: ${row.training_status})`)
  }
  if (!row.talking_photo_id) throw new Error(`Avatar ${rawAvatarId} has no talking_photo_id — re-create it from the Avatars page`)
  return row.talking_photo_id
}

async function dispatchAvatar(segment, heygenAvatarId, voiceUrl, aspectRatio) {
  if (!heygenAvatarId) throw new Error('No avatar configured on the video — set one in the form')
  if (!voiceUrl) throw new Error('Voice must be generated first (sequencing bug)')
  const dimensionMap = { '16:9': '16:9', '9:16': '9:16', '1:1': '1:1' }
  const resp = await generateVideoV3({
    avatarId: heygenAvatarId,
    audioUrl: voiceUrl,
    modelKey: 'v4',
    extras: {
      title: `Studio segment ${segment.segment_index + 1}`,
      aspect_ratio: dimensionMap[aspectRatio] || '16:9',
      resolution: '1080p',
      motion_prompt: segment.motion_gesture_prompt || '',
    },
  })
  const videoId = resp?.data?.video_id || resp?.video_id || resp?.id
  if (!videoId) {
    // Surface HeyGen's actual error so users see what's wrong instead of a generic message.
    const msg = resp?.data?.error?.message || resp?.error?.message || resp?.message || JSON.stringify(resp).slice(0, 300)
    throw new Error(`HeyGen rejected the avatar render: ${msg}`)
  }
  return videoId
}

// Single-segment orchestrator. Determines what jobs this segment needs based
// on its type, runs them in the right order, and patches its row at every
// state transition so Realtime subscribers see live progress.
//
// ctx.only_types: optional whitelist of asset classes to (re)generate.
//   undefined / empty array → smart default: fill in whatever's missing
//   ['voice']               → only synthesize voice, never touch image/avatar
//   ['image']               → only generate B-roll images
//   ['avatar']              → only render avatar videos
//   any combination         → only the listed classes are touched
//
// Used by the UI to let users pay only for what they actually want to
// regenerate (e.g. "I just want to re-test the voice alignment" should
// not re-spend HeyGen credits on the same avatar segments).
async function orchestrateSegment(segment, ctx) {
  const { videoId: parentId, profileId, voiceId, avatarId, aspectRatio, kieKey, force, only_types } = ctx
  const wants = (cls) => !only_types || only_types.length === 0 || only_types.includes(cls)

  const patch = async (body) => {
    await supaFetch(`studio_segments?id=eq.${segment.id}`, {
      method: 'PATCH', body, prefer: 'return=minimal',
    }).catch(() => {})
  }
  const fail = async (msg) => { await patch({ status: 'error', error: msg.slice(0, 500) }) }

  // Bail-outs that mean "nothing to do for this row"
  if (!segment.approved) {
    if (segment.status !== 'pending') await patch({ status: 'pending' })
    return
  }
  if (segment.segment_type === 'pure_motion_graphics') {
    // No assets needed; final bake renders the HF composition directly.
    if (segment.status !== 'ready') await patch({ status: 'ready', error: null })
    return
  }

  // Skip rows that are already done unless force=1 (used by "regenerate this row")
  if (!force && segment.status === 'ready' && segment.voice_url &&
      (segment.segment_type !== 'voiceover_broll' || segment.image_url) &&
      (segment.segment_type !== 'avatar' || segment.avatar_video_url)) {
    return
  }

  try {
    // Step 1 — voice (every non-pure-motion segment needs it)
    let voiceUrl = segment.voice_url
    if (!voiceUrl && wants('voice')) {
      await patch({ status: 'generating_audio', error: null })
      voiceUrl = await dispatchVoice(segment, voiceId, profileId)
      if (voiceUrl) {
        await patch({ voice_url: voiceUrl })
        // Keep the local segment object in sync so Step 2's
        // "is voice+image done?" check below doesn't see a stale
        // null and skip the ready transition.
        segment.voice_url = voiceUrl
      }
    }

    // Step 2 — type-specific async job
    if (segment.segment_type === 'voiceover_broll') {
      if (!segment.image_url && wants('image')) {
        await patch({ status: 'generating_image' })
        const taskId = await dispatchImage(segment, kieKey, aspectRatio)
        await patch({ kie_task_id: taskId })
        // status stays 'generating_image' until the poller fills image_url + flips to 'ready'
      } else if (segment.voice_url && segment.image_url) {
        await patch({ status: 'ready', error: null })
      }
      return
    }
    if (segment.segment_type === 'avatar') {
      if (!segment.avatar_video_url && wants('avatar') && voiceUrl) {
        await patch({ status: 'generating_avatar' })
        const videoId = await dispatchAvatar(segment, ctx.heygenAvatarId, voiceUrl, aspectRatio)
        await patch({ heygen_video_id: videoId })
      } else if (segment.voice_url && segment.avatar_video_url) {
        await patch({ status: 'ready', error: null })
      } else if (voiceUrl && !wants('avatar')) {
        // User opted out of avatar generation (the "Avatar videos"
        // checkbox is OFF — they plan to export audio and render
        // avatars on their own platform). Voice is done, no avatar
        // job will fire. Mark ready so the UI un-spinners. The
        // segment will surface an Upload affordance until the user
        // attaches an avatar video.
        await patch({ status: 'ready', error: null })
      }
      return
    }
    if (segment.segment_type === 'voiceover_motion_graphics') {
      // Voice is the only async asset; HF comp renders at bake time.
      if (segment.voice_url || voiceUrl) await patch({ status: 'ready', error: null })
      return
    }
  } catch (e) {
    await fail(e.message)
  }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })
  const auth = await requireUser(req, res)
  if (!auth) return
  try {
    gateStudio(auth.user.id)

    const videoId = req.body?.studio_video_id
    if (!videoId) return res.status(400).json({ error: 'studio_video_id required' })

    // Load video + verify access
    const vRows = await supaFetch(`studio_videos?id=eq.${videoId}&select=*&limit=1`)
    const video = vRows?.[0]
    if (!video) return res.status(404).json({ error: 'Video not found' })
    await assertProfileAccess(auth.user.id, video.profile_id)

    // Credit gate — block before we burn provider quotas the user
    // can't actually afford. Skips when this is a per-segment regen
    // (segment_ids set) since those small individual regens are
    // cheap and the user already paid for the macro spend at
    // generation time.
    const isSingleSegment = Array.isArray(req.body?.segment_ids) && req.body.segment_ids.length
    if (!isSingleSegment) {
      const creditErr = await checkCredits(auth.user.id, video)
      if (creditErr) return res.status(402).json({ error: creditErr.error, code: creditErr.code })
    }

    // Resolve voice/avatar — fall back to brand profile defaults when the
    // video's own ids are blank. For now we only read the video's columns;
    // proper resolution against the brand-default-avatar/voice library
    // arrives with the next polish pass.
    // Voice fallback: when the video row has no voice_id (created from
    // the slimmed-down form which doesn't expose a voice picker), pull
    // it from the linked avatar's elevenlabs_voice_id. Patch back onto
    // the video so subsequent calls don't have to redo this lookup.
    if (!video.voice_id && video.avatar_id) {
      try {
        const avatarRow = (await supaFetch(
          `avatars?id=eq.${video.avatar_id}&select=elevenlabs_voice_id`
        ))?.[0]
        const v = avatarRow?.elevenlabs_voice_id
        if (v) {
          video.voice_id = v
          await supaFetch(`studio_videos?id=eq.${videoId}`, {
            method: 'PATCH',
            body: { voice_id: v },
            prefer: 'return=minimal',
          }).catch(() => {})
        }
      } catch { /* fall through to the 400 below */ }
    }
    if (!video.voice_id) {
      return res.status(400).json({ error: 'No voice selected. Set a voice on the video before continuing.' })
    }

    const kieKey = process.env.KIE_API_KEY
    if (!kieKey) return res.status(500).json({ error: 'KIE_API_KEY not configured on the server.' })

    // Load all approved segments. Pure motion graphics rows are included so
    // we can flip their status to 'ready' (they need no assets pre-rendered).
    let segments = await supaFetch(
      `studio_segments?studio_video_id=eq.${videoId}&select=*&order=segment_index.asc&limit=500`
    )

    // segment_ids: optional whitelist. When the UI fires a per-row
    // "regenerate" button, it sends just that segment's id so the
    // orchestrator only burns provider credits on that one. When
    // omitted, fall through to the original behavior (work the whole
    // video). Filter against ALL segments — the orchestrator still
    // gets to see the targeted row + any pure-motion siblings it
    // wants to flip to ready, but the rest are skipped.
    const segmentIdsRaw = Array.isArray(req.body?.segment_ids) ? req.body.segment_ids : null
    if (segmentIdsRaw?.length) {
      const wanted = new Set(segmentIdsRaw)
      segments = segments.filter((s) => wanted.has(s.id))
    }

    // Flip parent status to 'rendering' so the UI shows progress immediately.
    await supaFetch(`studio_videos?id=eq.${videoId}`, {
      method: 'PATCH', body: { status: 'rendering', error: null }, prefer: 'return=minimal',
    })

    // only_types: optional whitelist of asset classes to (re)generate. If
    // present, segments only get jobs for the listed classes; missing
    // assets in other classes are left alone. UI uses this to let users
    // pay only for what they actually want to refresh (e.g. "voice only"
    // for alignment checks, "avatar only" to refresh HeyGen renders).
    const ALLOWED_TYPES = new Set(['voice', 'image', 'avatar'])
    const onlyTypesRaw = Array.isArray(req.body?.only_types) ? req.body.only_types : null
    const only_types = onlyTypesRaw
      ? onlyTypesRaw.filter((t) => ALLOWED_TYPES.has(t))
      : null
    const wantAvatar = !only_types || only_types.includes('avatar')

    // Resolve the HeyGen-renderable avatar id ONCE up front (only if we
    // actually intend to dispatch avatar jobs). The video's avatar_id
    // column is a ScaleSolo row id (or pub:/default: prefix); HeyGen's
    // /v3/videos endpoint wants the actual talking_photo_id / avatar id.
    // Failing here surfaces a clear error before we burn voice synth on
    // a render that's destined to fail.
    let heygenAvatarId = null
    const hasAvatarSegments = segments.some((s) => s.approved && s.segment_type === 'avatar')
    if (hasAvatarSegments && wantAvatar) {
      if (!video.avatar_id) {
        return res.status(400).json({ error: 'This video has avatar segments but no avatar selected. Pick one in the form or change the avatar segments to voiceover.' })
      }
      try {
        heygenAvatarId = await resolveHeygenAvatarId(video.avatar_id, video.look_id)
        if (!heygenAvatarId) throw new Error('Could not resolve HeyGen avatar id from the selected avatar')
      } catch (e) {
        return res.status(400).json({ error: e.message })
      }
    }

    const ctx = {
      videoId,
      profileId: video.profile_id,
      voiceId: video.voice_id,
      avatarId: video.avatar_id || null,
      heygenAvatarId,
      aspectRatio: video.aspect_ratio || '16:9',
      kieKey,
      force: req.body?.force === true,
      only_types,
    }

    // Fan out per-segment work. Each call has its own try/catch inside; one
    // failure doesn't block siblings. Concurrency cap dropped from 6 → 4 —
    // 6 parallel ElevenLabs streams was causing the rate-limit queue to
    // serialize requests behind the scenes, surfacing as "stuck pending"
    // segments after 300s. With 4 in flight, the API responds smoothly
    // and the orchestrator finishes within budget on 10-segment videos.
    const CONCURRENCY = 4
    const queue = segments.slice()
    const running = []
    const runNext = () => {
      const seg = queue.shift()
      if (!seg) return null
      const p = orchestrateSegment(seg, ctx).then(() => {
        const idx = running.indexOf(p)
        if (idx >= 0) running.splice(idx, 1)
      })
      running.push(p)
      return p
    }
    while (queue.length || running.length) {
      while (running.length < CONCURRENCY && queue.length) runNext()
      if (running.length) await Promise.race(running)
    }

    // Return the current state. Async jobs (image, avatar) may still be in
    // flight; the poller endpoint picks them up from here.
    const fresh = await supaFetch(
      `studio_videos?id=eq.${videoId}&select=*,studio_segments(*)&studio_segments.order=segment_index.asc&limit=1`
    )
    return res.status(200).json({ video: fresh?.[0] || null })
  } catch (err) {
    return res.status(err.status || 500).json({ error: err.message })
  }
}
