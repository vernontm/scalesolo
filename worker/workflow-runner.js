// Server-side workflow executor for scheduled workflows.
//
// Walks a serialized space graph in topological order, calling each
// node's API counterpart on the main Vercel app via internal-secret
// auth. Outputs accumulate in a Map keyed by node id, and downstream
// nodes pick from upstream outputs via the same input-bag pattern the
// browser canvas uses.
//
// ⚠️  WHEN ADDING A NEW NODE TYPE TO THE BROWSER CANVAS:
//     Add a matching runner to NODE_RUNNERS below using the EXACT
//     same key as the registry entry in src/lib/space-nodes.jsx. The
//     runner's output shape must match the browser run() return so
//     downstream nodes consume it the same way. Unsupported types
//     fail gracefully with "Server runs don't support node type X
//     yet" — visible in the user's bell + scheduled_workflows
//     last_error — but the workflow can't complete until you add it.
//     Server runners and browser run()s should be considered a
//     single contract; ship them together.
//
// Design constraints:
//   1. No React, no DOM. Just Node fetch.
//   2. No source-of-truth duplication for prompts / model names —
//      every node calls the SAME Vercel endpoint a manual canvas
//      run would hit, just with an internal-secret header.
//   3. Best-effort: a single failed non-terminal node is allowed to
//      poison its descendants but doesn't abort the whole run. The
//      cron caller stores the final error message on the schedule.
//
// Coverage (must mirror NODE_REGISTRY in src/lib/space-nodes.jsx):
//   Inputs:      text_input, url_reference, brand_profile, auto_run,
//                image_upload, audio_upload, collection,
//                avatar_picker
//   Generators:  script_gen, caption_gen, voice_gen, image_gen,
//                avatar_render (single + randomize / chunked),
//                combine_videos, captions (legacy), combine (legacy)
//   Outputs:     video_polish, schedule_post, save_library
//
//   Unsupported: anything else throws "Server-runs don't support
//   <type> yet". The graph still completes whatever's runnable.

const PORTABLE_BASE = process.env.VERCEL_API_BASE || 'https://scalesolo.vercel.app'

function makeHeaders({ userId, internalSecret }) {
  return {
    'Content-Type': 'application/json',
    'x-internal-secret': internalSecret,
    'x-impersonate-user': userId,
  }
}

async function callApi(path, body, headers) {
  const r = await fetch(`${PORTABLE_BASE}${path}`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await r.text()
  let parsed = null
  try { parsed = text ? JSON.parse(text) : null } catch {}
  if (!r.ok) {
    const msg = parsed?.error || (text && text.length < 200 ? text.trim() : `${path} → ${r.status}`)
    const err = new Error(msg)
    err.status = r.status
    err.response = parsed
    throw err
  }
  return parsed
}

// ── input-bag helpers ──────────────────────────────────────────────────────
// Same shape pickers the browser-side runtime uses. Mirrored here so
// nothing is shared at runtime — keeps the worker independent of the
// React bundle.
function asArr(v) {
  if (v == null) return []
  return Array.isArray(v) ? v : [v]
}
function pickScript(bag) {
  for (const v of asArr(bag)) {
    if (!v) continue
    if (typeof v === 'string') return v
    if (typeof v.script === 'string')        return v.script
    if (typeof v.full_script === 'string')   return v.full_script
    if (typeof v.text === 'string')          return v.text
    if (typeof v.caption === 'string' && !v.full_script) return v.caption
  }
  return ''
}
function pickBrand(bag) {
  for (const v of asArr(bag)) if (v?.brand?.profile_id) return v.brand
  return null
}
function pickAvatar(bag) {
  for (const v of asArr(bag)) if (v?.avatar?.avatar_id) return v.avatar
  return null
}
function pickAllVideoUrls(bag) {
  const seen = new Set(), out = []
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u) } }
  for (const v of asArr(bag)) {
    if (!v || typeof v !== 'object') continue
    if (v.video?.video_url) push(v.video.video_url)
    if (v.video_url) push(v.video_url)
    // image_upload emits videos: [{ url, name }] — NOT { video_url }.
    // polish + combine_videos emit { video_url, idx }. Accept both shapes
    // so caption_gen / polish / schedule_post detect fan-out correctly
    // regardless of which upstream node sourced the clips. Without the
    // .url fallback, a 5-video Upload media → caption_gen run only saw
    // the first clip's URL (via v.video_url flat field) and single-clip
    // path ran instead of fan-out — exactly the symptom users hit.
    if (Array.isArray(v.videos)) {
      for (const c of v.videos) {
        if (c?.video_url) push(c.video_url)
        else if (c?.url && /\.(mp4|mov|webm|m4v|mkv)(\?|#|$)/i.test(c.url)) push(c.url)
      }
    }
    if (Array.isArray(v.items)) {
      for (const it of v.items) if (it?.kind === 'video' && it.url) push(it.url)
    }
  }
  return out
}
function pickAllImageUrls(bag) {
  const seen = new Set(), out = []
  const push = (u) => { if (u && !seen.has(u)) { seen.add(u); out.push(u) } }
  for (const v of asArr(bag)) {
    if (!v || typeof v !== 'object') continue
    if (Array.isArray(v.images)) for (const im of v.images) if (im?.url) push(im.url)
    if (typeof v.url === 'string' && /\.(png|jpe?g|webp|gif)(\?|#|$)/i.test(v.url)) push(v.url)
    if (typeof v.image_url === 'string') push(v.image_url)
  }
  return out
}

// ── per-node runners ───────────────────────────────────────────────────────
// Each returns the same shape the browser-side run() would return so
// downstream nodes pick up fields the same way.
const NODE_RUNNERS = {
  text_input: ({ node }) => ({ text: node.data?.props?.text || '' }),

  url_reference: ({ node }) => ({ url: node.data?.props?.url || '' }),

  brand_profile: ({ node }) => ({ brand: { profile_id: node.data?.props?.profile_id, ...node.data?.props } }),

  auto_run: () => ({ tick: new Date().toISOString() }),

  collection: ({ inputs }) => {
    // Aggregator — just passes everything through bagged.
    const items = []
    for (const v of asArr(inputs)) {
      if (v?.video_url) items.push({ kind: 'video', url: v.video_url })
      else if (v?.url) items.push({ kind: 'image', url: v.url })
    }
    return { items }
  },

  // Registry key is `image_upload` (the "Upload media" UI node).
  // Reads stored urls from props — files were uploaded earlier via
  // the browser; server runs just pass the saved URLs through.
  image_upload: ({ node }) => {
    const urls = Array.isArray(node.data?.props?.urls) ? node.data.props.urls : []
    const videos = urls.filter((u) => u.kind === 'video').map((u) => ({ url: u.url, name: u.name }))
    const images = urls.filter((u) => u.kind !== 'video').map((u) => ({ url: u.url, name: u.name }))
    const out = { images }
    if (videos.length) { out.videos = videos; out.video_url = videos[0].url }
    return out
  },

  // Audio file uploaded earlier; we just emit the stored URL with
  // its duration so downstream avatar_render can size chunks.
  audio_upload: ({ node }) => {
    const url = node.data?.props?.url
    if (!url) throw new Error('audio_upload: no file uploaded. Upload one in the browser first.')
    return {
      audio: {
        url,
        name: node.data?.props?.name || '',
        duration_secs: Number(node.data?.props?.duration_secs || 0) || null,
        // Top-level audio_url marker so this is recognized as
        // MUSIC by polish (not as a voiceover, which uses
        // audio.url). audio_upload is the music-overlay source;
        // voice_gen is the voiceover source.
        audio_url: url,
      },
    }
  },

  image_gen: async ({ node, inputs, ctx }) => {
    const props = node.data?.props || {}
    const brand = pickBrand(inputs)
    const profileId = brand?.profile_id || ctx.profileId
    const prompt = (props.prompt || '').trim() || pickScript(inputs)
    if (!prompt) throw new Error('image_gen needs a prompt (either in the node prop or upstream text)')

    // Reference images: collect every image URL from the upstream
    // bag. The browser canvas runs a richer @mention resolution
    // step — server runs use the simpler "everything upstream is
    // a candidate ref" rule which covers 95% of real flows.
    const refs = []
    for (const v of asArr(inputs)) {
      if (Array.isArray(v?.images)) for (const im of v.images) if (im?.url) refs.push(im.url)
      else if (v?.url && /\.(png|jpe?g|webp)(\?|$)/i.test(v.url)) refs.push(v.url)
    }

    const count = Math.max(1, Math.min(8, Number(props.count) || 1))
    // KIE returns 1 image per submit reliably regardless of
    // num_images flag, so we fan out N parallel count=1 tasks
    // and combine. Same pattern the browser uses.
    const submitOne = async () => {
      const sub = await callApi('/api/images/generate', {
        profile_id: profileId,
        prompt,
        model: props.model || 'nano-banana',
        count: 1,
        aspect: props.aspect || '1:1',
        quality: props.quality || '2K',
        reference_urls: refs.length ? refs : undefined,
        enhance_prompt: props.enhance_prompt ?? true,
      }, ctx.headers)
      const taskId = sub.taskId
      if (!taskId) throw new Error('image_gen submit returned no taskId')
      // Poll. 12-min ceiling matches the browser canvas. Most KIE
      // renders complete in 20-60s.
      const POLL_INTERVAL_MS = 4_000
      const DEADLINE_MS = 12 * 60_000
      const start = Date.now()
      while (Date.now() - start < DEADLINE_MS) {
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
        const r = await fetch(`${PORTABLE_BASE}/api/images/status?taskId=${encodeURIComponent(taskId)}`, { headers: ctx.headers })
        const s = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(s?.error || `image-status ${r.status}`)
        if (s.state === 'success' && Array.isArray(s.images) && s.images.length) {
          return s.images.map((im) => ({ url: im.url || im, name: '' }))
        }
        if (s.state === 'failed') throw new Error(s.error || 'Image gen failed')
      }
      throw new Error(`image_gen poll timed out after ${DEADLINE_MS / 60_000} min`)
    }
    const settled = await Promise.allSettled(Array.from({ length: count }, () => submitOne()))
    const images = []
    for (const s of settled) if (s.status === 'fulfilled') images.push(...s.value)
    if (!images.length) {
      const first = settled.find((s) => s.status === 'rejected')
      throw new Error(`image_gen failed: ${first?.reason?.message || 'unknown'}`)
    }
    return { images, media_type: 'image' }
  },

  // Legacy ZapCap-only caption burner. Replaced by video_polish's
  // built-in caption pass. We still ship a runner so older saved
  // spaces don't break — just forward to /api/videos/polish with
  // captions-only config.
  captions: async ({ node, inputs, ctx }) => {
    const p = node.data?.props || {}
    const videoUrl = pickAllVideoUrls(inputs)[0]
    if (!videoUrl) throw new Error('captions needs an upstream video')
    if (!p.caption_template_id) throw new Error('captions: pick a ZapCap template in the node settings')
    const body = await callApi('/api/videos/polish', {
      profile_id: ctx.profileId,
      video_url: videoUrl,
      captions_enabled: true,
      caption_template_id: p.caption_template_id,
      caption_language: p.caption_language || undefined,
    }, ctx.headers)
    return {
      video: { video_url: body.video_url },
      video_url: body.video_url,
      polished: true,
    }
  },

  // Legacy hidden Combine node — replaced by combine_videos. Some
  // saved spaces still have it. Treat as a pass-through aggregator
  // so the run doesn't error out on something the user can't see
  // in the palette anymore.
  combine: ({ inputs }) => {
    let videoUrl = null
    const images = []
    let script = '', caption = '', hashtags = ''
    for (const v of asArr(inputs)) {
      if (!v || typeof v !== 'object') continue
      if (!videoUrl && (v.video?.video_url || v.video_url)) videoUrl = v.video?.video_url || v.video_url
      if (Array.isArray(v.images)) for (const im of v.images) if (im?.url) images.push({ url: im.url })
      if (!script && (v.script || v.full_script)) script = v.script || v.full_script
      if (!caption && v.caption) caption = v.caption
      if (!hashtags && v.hashtags) hashtags = v.hashtags
    }
    return {
      bundle: true,
      script, caption, hashtags,
      video_url: videoUrl,
      images: images.length ? images : undefined,
      media_type: videoUrl ? 'video' : (images.length ? 'image' : 'text'),
    }
  },

  avatar_picker: ({ node }) => ({ avatar: { ...node.data?.props } }),

  // Avatar render. Supports the three modes the browser canvas
  // exposes:
  //
  //   1. Single-clip: one photo + (audio or script) → one HeyGen
  //      render. Default for avatars with a specific image_id set
  //      on the picker.
  //
  //   2. Pre-chunked randomize: voice_gen randomize emits
  //      audio_chunks[{ image_url, audio_url, order, sentence }].
  //      We fan out one HeyGen render per chunk in parallel. This
  //      is the canonical voice_gen → avatar_render randomize wire.
  //
  //   3. Single audio + look randomize: a non-chunked audio source
  //      with an avatar in randomize mode + look_id. We call
  //      /api/avatars/audio-chunks to split the audio against the
  //      look's image count, then fan out like (2).
  //
  // Each clip submits via /api/avatars/photo-render and polls
  // /api/avatars/photo-render-status. Concurrency 4 keeps HeyGen
  // happy without serializing the whole batch.
  avatar_render: async ({ inputs, ctx, log }) => {
    const avatar = pickAvatar(inputs)
    if (!avatar?.avatar_id) throw new Error('avatar_render needs an Avatar picker upstream')

    let audioUrl = null
    let audioDurationSecs = null
    let preChunkedAudio = null  // [{ image_url, audio_url, order, sentence }]
    let script = ''
    for (const v of asArr(inputs)) {
      if (!v || typeof v !== 'object') continue
      if (!audioUrl && v.audio?.url) { audioUrl = v.audio.url; audioDurationSecs = v.audio.duration_secs }
      if (!audioUrl && v.audio?.audio_url) audioUrl = v.audio.audio_url
      if (!script && (v.script || v.full_script)) script = v.script || v.full_script
      if (!preChunkedAudio && Array.isArray(v.audio_chunks) && v.audio_chunks.length > 0) {
        preChunkedAudio = v.audio_chunks
      }
    }
    if (!audioUrl && !script && !preChunkedAudio) {
      throw new Error('avatar_render needs upstream voice_gen audio, a script, or audio_chunks')
    }

    // Shared single-clip submit + poll. Used by every mode below.
    const renderOne = async ({ photo_url, audio_url, scriptChunk }) => {
      const submit = await callApi('/api/avatars/photo-render', {
        profile_id: ctx.profileId,
        avatar_id: avatar.avatar_id,
        photo_url,
        audio_url: audio_url || undefined,
        script: !audio_url && scriptChunk ? scriptChunk : undefined,
        voice_id: avatar.voice_id || undefined,
      }, ctx.headers)
      const videoId = submit.video_id
      if (!videoId) throw new Error('No video_id returned from photo-render')
      const POLL_INTERVAL_MS = 6_000
      const DEADLINE_MS = 10 * 60_000
      const start = Date.now()
      while (Date.now() - start < DEADLINE_MS) {
        await new Promise((res) => setTimeout(res, POLL_INTERVAL_MS))
        const r = await fetch(
          `${PORTABLE_BASE}/api/avatars/photo-render-status?video_id=${encodeURIComponent(videoId)}`,
          { headers: ctx.headers }
        )
        const s = await r.json().catch(() => ({}))
        if (!r.ok) throw new Error(s?.error || `photo-render-status ${r.status}`)
        if (s.state === 'success') return { video_url: s.video_url, video_id: videoId }
        if (s.state === 'failed') throw new Error(s.error || 'HeyGen render failed')
      }
      throw new Error(`Single render timed out after ${DEADLINE_MS / 60_000} min`)
    }

    // Fan-out helper: parallel render-and-poll with bounded
    // concurrency. Same Promise.allSettled pattern the browser
    // canvas uses so a single bad clip doesn't poison the batch.
    const renderClips = async (assignments) => {
      const CONCURRENCY = 4
      const results = new Array(assignments.length)
      let cursor = 0
      const workers = Array.from({ length: Math.min(CONCURRENCY, assignments.length) }, async () => {
        while (cursor < assignments.length) {
          const i = cursor++
          const a = assignments[i]
          try {
            log?.(`avatar_render clip ${i + 1}/${assignments.length} submitting…`)
            const r = await renderOne(a)
            results[i] = {
              video_url: r.video_url,
              order: a.order ?? i,
              image_url: a.photo_url,
              sentence: a.sentence || '',
              audio_chunk_url: a.audio_url || null,
            }
          } catch (err) {
            results[i] = { failed: true, error: err?.message || String(err), order: a.order ?? i }
          }
        }
      })
      await Promise.all(workers)
      const clips = results.filter((r) => r && !r.failed)
      const failures = results
        .map((r, i) => r?.failed ? { clip_index: i, error: r.error } : null)
        .filter(Boolean)
      if (!clips.length) {
        throw new Error(`All ${assignments.length} clips failed. First: ${failures[0]?.error || 'unknown'}`)
      }
      return {
        videos: clips,
        media_type: 'video',
        is_clip_set: true,
        ...(failures.length ? { partial_failures: failures } : {}),
      }
    }

    // ── Mode 2: pre-chunked audio from voice_gen randomize ──────────────
    if (preChunkedAudio && preChunkedAudio.length > 0) {
      log?.(`avatar_render: pre-chunked randomize (${preChunkedAudio.length} clips)`)
      if (preChunkedAudio.length === 1) {
        const a = preChunkedAudio[0]
        const r = await renderOne({ photo_url: a.image_url, audio_url: a.audio_url })
        return { video: { video_url: r.video_url }, video_url: r.video_url, media_type: 'video' }
      }
      const assignments = preChunkedAudio.map((a, i) => ({
        photo_url: a.image_url,
        audio_url: a.audio_url,
        order: a.order ?? i,
        sentence: a.sentence,
      }))
      return await renderClips(assignments)
    }

    // ── Modes 1 & 3 both need to know the avatar's image set ────────────
    const wantsRandomize = avatar.mode === 'randomize'
    const couldAutoRandomize = avatar.mode === 'single' && !avatar.image_id && avatar.look_id
    const singleSpecificImage = avatar.image_url || avatar.photo_url

    if (!wantsRandomize && !couldAutoRandomize && singleSpecificImage) {
      // ── Mode 1: classic single-clip ──────────────────────────────────
      log?.(`avatar_render: single-clip`)
      const r = await renderOne({
        photo_url: singleSpecificImage,
        audio_url: audioUrl,
        scriptChunk: script,
      })
      return { video: { video_url: r.video_url }, video_url: r.video_url, media_type: 'video' }
    }

    // ── Mode 3: server-side audio chunking against look images ──────────
    // Fetch the look's images then call /api/avatars/audio-chunks to
    // split the audio against the image count.
    if (!avatar.look_id) {
      throw new Error('avatar_render randomize mode needs a look_id on the avatar picker')
    }
    log?.(`avatar_render: fetching look images for ${avatar.look_id}`)
    const imgR = await fetch(
      `${PORTABLE_BASE}/api/avatars/look-images?look_id=${encodeURIComponent(avatar.look_id)}`,
      { headers: ctx.headers }
    )
    const imgBody = await imgR.json().catch(() => ({}))
    if (!imgR.ok) throw new Error(imgBody?.error || `look-images ${imgR.status}`)
    const images = (imgBody.images || []).slice().sort((a, b) => (a.order_index || 0) - (b.order_index || 0))
    if (!images.length) throw new Error('Look has no images')

    // Single-image look — just render once.
    if (images.length === 1) {
      const r = await renderOne({
        photo_url: images[0].image_url,
        audio_url: audioUrl,
        scriptChunk: audioUrl ? '' : script,
      })
      return { video: { video_url: r.video_url }, video_url: r.video_url, media_type: 'video' }
    }

    // Audio-driven: chunk the audio across the look images.
    if (audioUrl) {
      const TARGET_CLIP_SECS = 7
      const clipsCount = Math.min(
        12,
        Math.max(images.length, Math.ceil((Number(audioDurationSecs) || images.length * TARGET_CLIP_SECS) / TARGET_CLIP_SECS))
      )
      log?.(`avatar_render: chunking audio into ${clipsCount} clips`)
      const chunkResp = await callApi('/api/avatars/audio-chunks', {
        audio_url: audioUrl,
        look_count: clipsCount,
        profile_id: ctx.profileId,
      }, ctx.headers)
      const chunks = Array.isArray(chunkResp.chunks) ? chunkResp.chunks : []
      if (!chunks.length) throw new Error('Audio chunking returned no chunks')
      const assignments = chunks.map((c, i) => ({
        photo_url: images[i % images.length].image_url,
        audio_url: c.audio_url,
        order: i,
        sentence: c.sentence,
      }))
      return await renderClips(assignments)
    }

    // Script-driven: HeyGen synthesizes per-clip via inline TTS. We
    // pair each look image with a slice of the script.
    log?.(`avatar_render: script-driven across ${images.length} look images`)
    const sentences = String(script).split(/(?<=[.!?])\s+/).filter(Boolean)
    const perImage = Math.max(1, Math.ceil(sentences.length / images.length))
    const assignments = images.map((img, i) => ({
      photo_url: img.image_url,
      scriptChunk: sentences.slice(i * perImage, (i + 1) * perImage).join(' '),
      order: i,
    })).filter((a) => a.scriptChunk)
    if (!assignments.length) throw new Error('Script too short to split across look images')
    return await renderClips(assignments)
  },

  script_gen: async ({ node, inputs, ctx }) => {
    const brand = pickBrand(inputs)
    const profileId = brand?.profile_id || ctx.profileId
    const props = node.data?.props || {}
    let topic = (props.topic || '').trim() || pickScript(inputs) || ''

    // Media-derived topic fallback. If no explicit topic is set:
    //   • video upstream → transcribe it, use the transcript as topic
    //     (script_gen will then rewrite a fresh on-brand version)
    //   • image upstream → Claude vision reads the image and proposes
    //     a brand-aligned topic angle
    // Lets users wire Upload media → script_gen → ... and have it Just
    // Work for either media type.
    if (!topic) {
      const videoUrls = pickAllVideoUrls(inputs)
      const imageUrls = pickAllImageUrls(inputs)
      const mediaBody = videoUrls[0] ? { video_url: videoUrls[0] }
                     : imageUrls[0] ? { image_url: imageUrls[0] }
                     : null
      if (mediaBody) {
        try {
          const body = await callApi('/api/content/topic-from-media', {
            profile_id: profileId, ...mediaBody,
          }, ctx.headers)
          topic = String(body?.topic || '').trim()
        } catch (e) {
          throw new Error(`script_gen could not derive a topic from upstream media: ${e?.message || e}`)
        }
      }
    }

    if (!topic) throw new Error('script_gen needs a topic, video, or image upstream')
    const body = await callApi('/api/content/generate', {
      profile_id: profileId,
      format: props.format || 'tiktok-script',
      topic,
      count: 1,
      target_length_secs: props.target_length_secs || undefined,
      dry_run: true,
    }, ctx.headers)
    const item = body.items?.[0] || {}
    return {
      script: item.full_script || '',
      full_script: item.full_script || '',
      title: item.title || '',
      hook: item.hook || '',
    }
  },

  // Generates per-platform native text posts (X / Threads / Facebook /
  // LinkedIn). User-edited overrides on the node's props.edited win over
  // freshly generated text.
  text_post_gen: async ({ node, inputs, ctx }) => {
    const brand = pickBrand(inputs)
    const profileId = brand?.profile_id || ctx.profileId
    const props = node.data?.props || {}
    const platforms = Array.isArray(props.platforms) && props.platforms.length
      ? props.platforms
      : ['x', 'threads', 'facebook', 'linkedin']
    // Use the upstream Text content as the prompt. Fall back to any
    // script-shaped input, then to the node's in-body Prompt textarea
    // (props.prompt).
    let prompt = ''
    for (const v of asArr(inputs)) {
      if (!v) continue
      if (typeof v === 'string') { prompt = v; break }
      if (typeof v !== 'object') continue
      if (typeof v.text === 'string' && v.text.trim()) { prompt = v.text; break }
      if (typeof v.script === 'string' && v.script.trim()) { prompt = v.script; break }
      if (typeof v.full_script === 'string' && v.full_script.trim()) { prompt = v.full_script; break }
    }
    if (!prompt.trim()) prompt = String(props.prompt || '').trim()
    if (!prompt.trim()) throw new Error('text_post_gen needs a prompt — type one in the node or wire a Text / Script node into "in".')
    const body = await callApi('/api/content/text-post-generate', {
      profile_id: profileId,
      prompt,
      platforms,
    }, ctx.headers)
    const edits = props.edited || {}
    const merged = {}
    for (const p of platforms) {
      merged[p] = (edits[p] && String(edits[p]).trim()) || body.per_platform?.[p] || ''
    }
    return {
      is_text_post: true,
      platforms,
      per_platform: merged,
      title:         props.edited_title         || body.title         || '',
      hashtags:      props.edited_hashtags      || body.hashtags      || '',
      first_comment: props.edited_first_comment || body.first_comment || '',
      caption: merged[platforms[0]] || '',
    }
  },

  caption_gen: async ({ inputs, ctx }) => {
    const brand = pickBrand(inputs)
    const profileId = brand?.profile_id || ctx.profileId
    let script = pickScript(inputs)
    const upstreamVideoUrls = pickAllVideoUrls(inputs)

    // ── MULTI-VIDEO FAN-OUT ────────────────────────────────────────────
    // When upload_media (or any upstream) emits 2+ videos AND there's no
    // explicit script, transcribe each clip and ask Claude for N caption
    // sets in ONE call. Mirrors the browser caption_gen's multi-clip
    // path. Output shape: { captions: [{idx, title, caption, hashtags,
    // first_comment, source_url}, ...], videos: [...] } + the first
    // clip's fields flattened on top for backward-compat consumers.
    if (!script && upstreamVideoUrls.length > 1) {
      const transcribeOne = async (url, idx) => {
        try {
          const body = await callApi('/api/videos/auto-title', {
            profile_id: profileId,
            video_url: url,
            transcript_only: true,
          }, ctx.headers)
          return { idx, text: String(body?.transcript || '').trim(), source_url: url }
        } catch (e) {
          console.warn(`[caption_gen] transcribe failed for clip ${idx}:`, e?.message)
          return { idx, text: '', source_url: url, error: e?.message || String(e) }
        }
      }
      // Concurrency 2 — Scribe is bandwidth-heavy and rate-limited.
      // Running all N in parallel empirically OOMs and trips per-key
      // limits; 2 is the sweet spot.
      const TRANSCRIBE_CONCURRENCY = 2
      const transcripts = new Array(upstreamVideoUrls.length)
      let tCursor = 0
      const tWorkers = Array.from({ length: Math.min(TRANSCRIBE_CONCURRENCY, upstreamVideoUrls.length) }, async () => {
        while (tCursor < upstreamVideoUrls.length) {
          const i = tCursor++
          transcripts[i] = await transcribeOne(upstreamVideoUrls[i], i)
        }
      })
      await Promise.all(tWorkers)

      const valid = transcripts.filter((t) => t.text.length >= 10)
      if (!valid.length) {
        const errs = transcripts.map((t) => t.error).filter(Boolean).slice(0, 2).join('; ')
        throw new Error(`caption_gen could not transcribe any of ${upstreamVideoUrls.length} videos${errs ? ` — ${errs}` : ''}`)
      }

      // ── Auto-batching ───────────────────────────────────────────────
      // Each caption set is ~200 output tokens (title + 1500-char caption
      // + hashtags + first_comment all serialized as JSON). With Claude
      // max_tokens=3000 we can fit ~12-14 sets cleanly; past that the
      // response truncates mid-JSON and later sets come back empty.
      // BATCH_SIZE=10 leaves comfortable headroom for the prompt prefix
      // and the closing JSON syntax — solid up to N=∞ since we just spin
      // up more batches in parallel.
      const BATCH_SIZE = 10
      const batches = []
      for (let i = 0; i < valid.length; i += BATCH_SIZE) {
        batches.push(valid.slice(i, i + BATCH_SIZE))
      }

      // Dedicated /api/content/caption-fanout endpoint — calls Claude
      // with a caption-writer system prompt scoped just to "produce
      // {sets:[...]} JSON". The older path went through
      // /api/content/generate which loaded a heavy script-writing
      // system prompt (hook archetype rotation, format hints, etc.)
      // that confused Claude into writing a script instead of returning
      // the sets[] array, causing "no sets across any batch" failures.
      const runBatch = async (batch) => {
        try {
          const body = await callApi('/api/content/caption-fanout', {
            profile_id: profileId,
            segments: batch.map((c) => ({ idx: c.idx, text: c.text })),
          }, ctx.headers)
          return Array.isArray(body?.sets) ? body.sets : []
        } catch (e) {
          console.warn(`[caption_gen] batch failed: ${e?.message}`)
          return []
        }
      }

      // Batches are independent — run them in parallel (Anthropic handles
      // concurrent requests fine and this keeps wall-clock to one Claude
      // call's worth even at 30+ videos).
      const allBatchResults = await Promise.all(batches.map(runBatch))
      const sets = allBatchResults.flat()
      if (!sets.length) throw new Error('caption_gen multi-clip fan-out returned no sets across any batch')

      // Re-pair sets to transcripts by idx (we instructed Claude to use
      // the segment's exact idx, so this should be a clean match even
      // across batches). Fall back to array position for stragglers.
      const byIdx = new Map()
      sets.forEach((s, i) => { byIdx.set(Number.isFinite(s?.idx) ? s.idx : i, s) })
      const captions = transcripts.map((t, i) => {
        const s = byIdx.get(t.idx) || sets[i] || {}
        return {
          idx: t.idx,
          order: t.idx,
          title:         String(s.title || '').slice(0, 200),
          caption:       String(s.caption || '').slice(0, 2000),
          hashtags:      String(s.hashtags || ''),
          first_comment: String(s.first_comment || '').slice(0, 400),
          source_url:    t.source_url,
        }
      })

      // Return the multi-clip bundle. Flatten the first clip's fields on
      // top for any downstream consumer that still reads the singular
      // shape (older nodes, single-clip polishes, etc.).
      const first = captions[0] || {}
      return {
        title:         first.title || '',
        caption:       first.caption || '',
        hashtags:      first.hashtags || '',
        first_comment: first.first_comment || '',
        captions,
        videos: upstreamVideoUrls.map((url, i) => ({ video_url: url, idx: i })),
        video_url: upstreamVideoUrls[0],
      }
    }

    // ── SINGLE-VIDEO / SCRIPT path ─────────────────────────────────────
    // No script and exactly one video → transcribe and continue with the
    // single-caption path below.
    if (!script && upstreamVideoUrls.length === 1) {
      try {
        const body = await callApi('/api/videos/auto-title', {
          profile_id: profileId,
          video_url: upstreamVideoUrls[0],
          transcript_only: true,
        }, ctx.headers)
        script = String(body?.transcript || '').trim()
      } catch (e) {
        throw new Error(`caption_gen could not transcribe video: ${e?.message || e}`)
      }
    }

    if (!script) throw new Error('caption_gen needs a script or a video upstream')
    // Use the same /api/content/generate endpoint the browser hits.
    // dry_run avoids inserting a separate content_scripts row — the
    // bundle gets persisted by schedule_post when it actually fires.
    //
    // Prompt mirrors src/lib/space-nodes.jsx runSingleCaptionFromScript.
    // The minimal one-liner version used to drop hashtags +
    // first_comment because the LLM occasionally returned just title +
    // caption when the schema wasn't spelled out. Spelling it out
    // (plus the explicit example JSON shape) gets all four every run.
    const prompt = `From the script below, write ONE canonical TITLE, CAPTION, FIRST_COMMENT, and exactly 5 HASHTAGS that will be used across every platform we publish to (TikTok, Instagram, YouTube, Facebook, X, LinkedIn, Threads, Pinterest, Bluesky). Aim for a tight, punchy caption that reads well on the longest-form platforms (Instagram / Facebook / LinkedIn) but doesn't feel bloated on the shorter ones, keep it under 1500 characters total. The platform layer truncates further for X / Threads / Bluesky automatically.

Title rules:
- ≤ 80 characters, click-worthy, no number prefix.
- Used as the YouTube title and the post title on platforms that surface a separate title field.

Caption rules:
- ≤ 1500 characters. Lead with a strong hook in the first sentence.
- Should land naturally on every platform, no platform-specific phrasing.
- Plain text, paragraph breaks ok.

Hashtags:
- EXACTLY 5 hashtags, space-separated, each starting with #.
- Lead with the brand's core hashtags from the brand bible, then add topic-specific ones.
- Always present, never empty. Same set for every platform.

First comment rules:
- ≤ 220 characters. A short engagement driver that lands as the first reply on the post.
- A punchy question, "save if this hit" call-to-action, or value-add follow-up thought.
- NEVER duplicates the caption.
- NEVER includes hashtags (those belong in the hashtags field).

Voice: stay on the brand bible's tone (already in your system context). NEVER use em dashes; use commas, periods, or colons.

Return ONLY valid JSON, no preamble, no markdown fences. Exact shape:
{
  "title": "",
  "caption": "",
  "first_comment": "",
  "hashtags": "#a #b #c #d #e"
}

Script:
"""
${String(script).slice(0, 2000)}
"""`
    const body = await callApi('/api/content/generate', {
      profile_id: profileId,
      format: 'ig-post',
      topic: prompt,
      count: 1,
      dry_run: true,
    }, ctx.headers)
    const item = body.items?.[0] || {}
    const raw = item.full_script || item.caption || ''
    let parsed = {}
    try {
      const cleaned = String(raw).replace(/```json\s*|```\s*/gi, '').trim()
      const m = cleaned.match(/\{[\s\S]*\}/)
      parsed = JSON.parse(m ? m[0] : cleaned)
    } catch {
      // Truncated / malformed JSON — fall back to tolerant field-by-field
      // regex extraction so a max_tokens hit doesn't end up shoveling
      // raw JSON into the caption.
      parsed = {}
      const cleaned = String(raw).replace(/```json\s*|```\s*/gi, '').trim()
      const grab = (key) => {
        const re = new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`, 'i')
        const m2 = cleaned.match(re)
        return m2 ? m2[1].replace(/\\"/g, '"').replace(/\\n/g, '\n') : ''
      }
      parsed.title         = grab('title')
      parsed.caption       = grab('caption')
      parsed.hashtags      = grab('hashtags')
      parsed.first_comment = grab('first_comment')
    }

    let canonical = {
      title:         String(parsed.title || '').slice(0, 200),
      caption:       String(parsed.caption || '').slice(0, 2000),
      hashtags:      String(parsed.hashtags || ''),
      first_comment: String(parsed.first_comment || '').slice(0, 400),
    }
    // Salvage from raw text when JSON parse partially failed — same
    // recovery path the browser uses. Without this, an LLM that wraps
    // the JSON in prose or omits a field leaves columns null in
    // content_scripts and the Schedule page shows empty hashtags.
    if (!canonical.caption && raw) {
      canonical.caption = String(raw).replace(/#[\w]+/g, '').trim().slice(0, 1500)
    }
    if (!canonical.hashtags && raw) {
      canonical.hashtags = (String(raw).match(/#[\w]+/g) || []).slice(0, 5).join(' ')
    }

    // Forward upstream videos so downstream nodes (video_polish,
    // schedule_post) can still find the media via pickAllVideoUrls.
    // Without this, wiring Upload media → caption_gen → Finish video
    // bombs the polish node with "needs an upstream video" because
    // caption_gen would otherwise strip everything but the caption text
    // fields. Mirrors the browser-side attachVideos pass. Reuses the
    // upstreamVideoUrls already pulled at the top of caption_gen (the
    // multi-clip fan-out path branched out earlier; if we reach here,
    // we're in the single-script path and the list might be 0 or 1).
    if (upstreamVideoUrls.length) {
      canonical.videos = upstreamVideoUrls.map((url, i) => ({ video_url: url, idx: i }))
      // Single-clip convenience: also expose the first URL flat so
      // older consumers that read `video_url` directly still pick it up.
      canonical.video_url = upstreamVideoUrls[0]
    }
    return canonical
  },

  voice_gen: async ({ node, inputs, ctx }) => {
    const avatar = pickAvatar(inputs)
    const script = pickScript(inputs)
    if (!script) throw new Error('voice_gen needs a script')
    const pickerVoiceId = node.data?.props?.picker_voice_id
    if (!avatar?.avatar_id && !pickerVoiceId) {
      throw new Error('voice_gen needs either an upstream Avatar or a picker_voice_id in props')
    }
    const body = await callApi('/api/avatars/synth-script', {
      profile_id: ctx.profileId,
      ...(avatar?.avatar_id ? { avatar_id: avatar.avatar_id } : { voice_id: pickerVoiceId, voice_owner: node.data?.props?.picker_voice_owner || 'shared' }),
      script,
      voice_settings: node.data?.props?.voice_settings_override || undefined,
      voice_model_id:  node.data?.props?.voice_model_id_override  || undefined,
      voice_language:  node.data?.props?.voice_language_override  || undefined,
    }, ctx.headers)
    return {
      audio: { url: body.audio_url, name: 'voice_gen.mp3' },
      script,
      full_script: script,
      ...(avatar ? { avatar } : {}),
      voice_used: body.voice_used || null,
    }
  },

  // Stitch a set of clips end-to-end into one MP4. Used after
  // avatar_render randomize to merge the N look-image clips back
  // into a single deliverable. Mirrors the browser path: try the
  // server-side ffmpeg combine API, fall back to a playlist shape
  // (videos[] array) if it's unavailable so downstream nodes still
  // have something to consume.
  combine_videos: async ({ inputs, ctx }) => {
    const clips = []
    for (const v of asArr(inputs)) {
      if (!v) continue
      if (Array.isArray(v.videos)) for (const c of v.videos) { if (c?.video_url) clips.push(c) }
      else if (Array.isArray(v.items)) for (const it of v.items) { if (it?.kind === 'video' && it.url) clips.push({ video_url: it.url, order: it.order }) }
      else if (v.video_url) clips.push({ video_url: v.video_url, order: v.order })
    }
    clips.sort((a, b) => (a.order ?? 1e9) - (b.order ?? 1e9))
    if (clips.length < 2) {
      // Server runs almost always reach this with N>=2 from avatar
      // randomize. If somehow N<2, treat it as a pass-through.
      if (clips.length === 1) return { video: { video_url: clips[0].video_url }, video_url: clips[0].video_url, media_type: 'video' }
      throw new Error('combine_videos needs at least 2 video clips upstream')
    }
    try {
      const body = await callApi('/api/videos/combine', {
        profile_id: ctx.profileId,
        video_urls: clips.map((c) => c.video_url),
      }, ctx.headers)
      if (body?.video_url) {
        return { video: { video_url: body.video_url, source_clips: clips.length }, video_url: body.video_url, media_type: 'video' }
      }
      // No video_url on a 200 → unknown failure. Fall through to
      // playlist so downstream nodes still see something.
      return { videos: clips, media_type: 'video', is_clip_set: true, combine_unavailable: 'No video_url in combine response' }
    } catch (e) {
      // Combine endpoint unreachable or threw — same fallback as
      // browser: pass the clips through so polish / schedule_post
      // can still fan out across them.
      return {
        videos: clips,
        media_type: 'video',
        is_clip_set: true,
        combine_unavailable: e?.message || 'combine failed',
      }
    }
  },

  // Merge audio + video into a single mp4. Used to pre-merge b-roll
  // uploads with voice_gen audio so polish gets a clean self-contained
  // clip the way avatar_render output is self-contained. -c:v copy on
  // the worker keeps this fast — typically 5-15s.
  combine_av: async ({ node, inputs, ctx }) => {
    const arr = asArr(inputs)
    let videoUrl = null
    let audioUrl = null
    for (const v of arr) {
      if (!v || typeof v !== 'object') continue
      if (!videoUrl) {
        if (v.video?.video_url) videoUrl = v.video.video_url
        else if (v.video_url) videoUrl = v.video_url
        else if (Array.isArray(v.videos) && v.videos[0]?.url) videoUrl = v.videos[0].url
      }
      if (!audioUrl) {
        if (v.audio?.url) audioUrl = v.audio.url
        else if (v.audio_url) audioUrl = v.audio_url
      }
    }
    if (!videoUrl) throw new Error('combine_av needs a video wired in')
    if (!audioUrl) throw new Error('combine_av needs an audio file wired in')
    const body = await callApi('/api/videos/combine-av', {
      profile_id: ctx.profileId,
      video_url: videoUrl,
      audio_url: audioUrl,
      loop_video: node.data?.props?.loop_video !== false,
    }, ctx.headers)
    return {
      video: { video_url: body.video_url },
      video_url: body.video_url,
      media_type: 'video',
      combined: true,
    }
  },

  video_polish: async ({ node, inputs, ctx }) => {
    const p = node.data?.props || {}
    const videoUrls = pickAllVideoUrls(inputs)
    if (!videoUrls.length) throw new Error('video_polish needs an upstream video')
    let voiceoverUrl = null, musicUrl = null, logoUrl = null
    let upstreamTitle = '', upstreamScript = ''
    for (const v of asArr(inputs)) {
      if (!v || typeof v !== 'object') continue
      if (!voiceoverUrl && v.audio?.url) voiceoverUrl = v.audio.url
      if (!musicUrl && v.audio?.audio_url) musicUrl = v.audio.audio_url
      if (!logoUrl && v.brand?.logo_url) logoUrl = v.brand.logo_url
      if (!upstreamTitle && typeof v.title === 'string') upstreamTitle = v.title
      if (!upstreamScript) {
        if (typeof v.script === 'string') upstreamScript = v.script
        else if (typeof v.full_script === 'string') upstreamScript = v.full_script
        else if (typeof v.text === 'string') upstreamScript = v.text
      }
    }
    // Resolve music source. Same modes as the browser run: library +
    // track id, random across the library, or a one-off custom URL.
    // For server runs we have to fetch the brand's tracks since they
    // aren't carried on the saved node props.
    if (!musicUrl) {
      const wantsLibrary = p.music_mode === 'random' || (p.music_mode === 'library' && p.music_track_id)
      if (wantsLibrary) {
        try {
          // Account-wide library (user_profiles.music_tracks). Same
          // tracks across every brand profile the user owns.
          const r = await fetch(`${PORTABLE_BASE}/api/account/music-tracks`, {
            headers: ctx.headers,
          })
          const body = await r.json().catch(() => ({}))
          const tracks = Array.isArray(body?.tracks) ? body.tracks : []
          if (p.music_mode === 'random' && tracks.length > 0) {
            musicUrl = tracks[Math.floor(Math.random() * tracks.length)]?.url || null
          } else if (p.music_mode === 'library' && p.music_track_id) {
            const pick = tracks.find((t) => t.id === p.music_track_id) || tracks[0]
            if (pick?.url) musicUrl = pick.url
          }
        } catch (e) {
          console.warn('[video_polish] music_tracks fetch failed:', e?.message)
        }
      }
      if (!musicUrl && p.music_url) musicUrl = p.music_url
    }
    // Title resolution. Three paths:
    //   - manual mode: use p.title verbatim (user typed it in)
    //   - auto mode + upstream wired:  use the upstream title
    //   - auto mode + no upstream:    call /api/videos/auto-title to
    //                                 transcribe + generate a fresh one
    //
    // Previously this was `upstreamTitle || p.title` which meant a
    // stale manually-typed value leaked into every auto-mode run when
    // the upstream wasn't wired — the OR short-circuited before
    // auto-title could fire. Now p.title is ONLY consulted in manual
    // mode, so auto runs always regenerate.
    const titleMode = p.title_mode || 'auto'
    let titleText = ''
    if (titleMode === 'manual') {
      titleText = (p.title || '').trim()
    } else {
      titleText = upstreamTitle || ''
    }
    if (!titleText && p.title_enabled !== false && titleMode === 'auto') {
      try {
        const at = await callApi('/api/videos/auto-title', {
          profile_id: ctx.profileId,
          video_url: videoUrls[0],
          transcript_text: upstreamScript || undefined,
        }, ctx.headers)
        if (at?.title) titleText = String(at.title).slice(0, 120)
      } catch (e) {
        // Don't fail the polish run over a missing title — the user
        // still gets a polished video, just without the big top
        // overlay. The schedule queue title comes from caption_gen
        // separately.
        console.warn('[video_polish] auto-title failed, continuing without overlay:', e?.message || e)
      }
    }

    // Look for per-clip captions/titles on the upstream bag. caption_gen
    // emits captions: [{ idx, title, caption, ... , source_url }] in
    // multi-clip mode — we use each entry's title for the matching clip
    // so polish overlays say what each video is actually about.
    let upstreamCaptions = null
    for (const v of asArr(inputs)) {
      if (v && Array.isArray(v.captions) && v.captions.length > 0) {
        upstreamCaptions = v.captions
        break
      }
    }
    const titleForClip = (idx) => {
      if (titleMode === 'manual') return titleText
      const c = upstreamCaptions?.find?.((x) => x.idx === idx) || upstreamCaptions?.[idx]
      const fromCaption = c?.title ? String(c.title).slice(0, 120) : ''
      return fromCaption || titleText
    }

    // ── Per-clip polish helper ─────────────────────────────────────────
    // Submits ONE polish job, handles the async polling path. Extracted
    // so the multi-clip fan-out below can call it in a concurrency-
    // capped loop without duplicating ~50 lines of polling boilerplate.
    const polishOne = async (videoUrl, idx) => {
      let body = await callApi('/api/videos/polish', {
        profile_id: ctx.profileId,
        video_url: videoUrl,
        logo_url: logoUrl || undefined,
        music_url: musicUrl || undefined,
        voiceover_url: voiceoverUrl || undefined,
        loop_video: voiceoverUrl ? true : undefined,
        mute_video_audio: voiceoverUrl ? true : undefined,
        title: titleForClip(idx) || undefined,
        captions_enabled: p.captions_enabled !== false,
        caption_template_id: p.caption_template_id || undefined,
        watermark_position: p.watermark_position || 'br',
        watermark_size_pct: p.watermark_size_pct ?? 25,
        music_volume: p.music_volume ?? 0.15,
        music_fade_secs: p.music_fade_secs ?? 1.0,
      }, ctx.headers)

      // Long-running jobs return 202 { polling: true, worker_job_id }
      // and we poll the worker until done. 18-min deadline stays well
      // under the worker's 20-min ffmpeg cap.
      if (body?.polling && body.worker_job_id) {
        const POLL_DEADLINE_MS = 18 * 60_000
        const POLL_INTERVAL_MS = 5_000
        const start = Date.now()
        while (Date.now() - start < POLL_DEADLINE_MS) {
          await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS))
          const sUrl = `${PORTABLE_BASE}/api/videos/polish-status?job_id=${encodeURIComponent(body.worker_job_id)}`
          const status = await fetch(sUrl, { headers: ctx.headers })
            .then(async (r) => {
              const text = await r.text()
              let parsed = null
              try { parsed = text ? JSON.parse(text) : null } catch {}
              if (!r.ok) return { status: 'error', error: parsed?.error || `polish-status ${r.status}` }
              return parsed
            })
            .catch((e) => ({ status: 'error', error: e.message }))
          if (status?.status === 'done' && status.result?.video_url) {
            body = status.result
            break
          }
          if (status?.status === 'failed' || status?.status === 'error') {
            throw new Error(status.error || 'polish worker reported failure')
          }
        }
        if (!body?.video_url) {
          throw new Error(`polish timed out (>${(POLL_DEADLINE_MS / 60_000) | 0}m of polling) for clip ${idx}`)
        }
      }
      if (!body?.video_url) throw new Error(`polish returned no video_url for clip ${idx}`)
      return body.video_url
    }

    // ── Single-clip path ────────────────────────────────────────────────
    if (videoUrls.length === 1) {
      const finalUrl = await polishOne(videoUrls[0], 0)
      return {
        video: { video_url: finalUrl },
        video_url: finalUrl,
        polished: true,
        title: titleForClip(0),
      }
    }

    // ── Multi-clip fan-out (SERIAL) ─────────────────────────────────────
    // Polish is serialized one clip at a time. We tried concurrency 2
    // and hit FUNCTION_INVOCATION_FAILED on Vercel — running two polish
    // chains in parallel doubles up the worker→Vercel→worker round-trip
    // load AND fights for the same ffmpeg CPU on the Fly worker, which
    // pushed Vercel functions past their resource budget. Serial is
    // slower (5 clips × 60-90s ≈ 5-8 min total) but reliable. We can
    // experiment with parallel again later once we move polish onto a
    // direct worker job queue without the Vercel hop in between.
    const polished = new Array(videoUrls.length)
    const errors = []
    for (let i = 0; i < videoUrls.length; i++) {
      try {
        polished[i] = { video_url: await polishOne(videoUrls[i], i), idx: i }
      } catch (e) {
        console.warn(`[video_polish] clip ${i} failed: ${e?.message}`)
        errors.push({ idx: i, error: e?.message || String(e) })
        polished[i] = null
      }
    }

    const successful = polished.filter(Boolean)
    if (!successful.length) {
      throw new Error(`All ${videoUrls.length} clips failed to polish: ${errors.slice(0, 2).map((e) => e.error).join('; ')}`)
    }

    return {
      // First successful clip's URL flattened for backward compat (single-
      // clip consumers downstream still work). videos[] is the canonical
      // fan-out output — schedule_post reads this array to submit N jobs.
      video: { video_url: successful[0].video_url },
      video_url: successful[0].video_url,
      videos: successful,
      polished: true,
      polished_count: successful.length,
      polish_failures: errors.length ? errors : undefined,
      // Forward upstream captions[] through polish so schedule_post can
      // match captions[i] → polished[i] downstream.
      captions: upstreamCaptions || undefined,
      title: titleForClip(0),
    }
  },

  schedule_post: async ({ node, inputs, ctx }) => {
    const p = node.data?.props || {}
    const platforms = Array.isArray(p.platforms) ? p.platforms : []
    if (!platforms.length) throw new Error('schedule_post needs platforms picked')

    // Collect everything off the upstream bag in one pass.
    let caption = '', hashtags = '', firstComment = '', title = '', script = ''
    const photoUrls = []
    let textPostBundle = null
    let videos = []            // multi-clip output from polish (preferred when present)
    let captionsArr = null     // per-clip caption sets from caption_gen
    let singleVideoUrl = null
    for (const v of asArr(inputs)) {
      if (!v || typeof v !== 'object') continue
      if (!title && v.title) title = v.title
      if (!script && (v.script || v.full_script)) script = v.script || v.full_script
      if (!caption && v.caption) caption = v.caption
      if (!hashtags && v.hashtags) hashtags = v.hashtags
      if (!firstComment && v.first_comment) firstComment = v.first_comment
      if (!videos.length && Array.isArray(v.videos) && v.videos.length > 0) videos = v.videos
      if (!singleVideoUrl) {
        if (v.video?.video_url) singleVideoUrl = v.video.video_url
        else if (v.video_url) singleVideoUrl = v.video_url
      }
      if (!captionsArr && Array.isArray(v.captions) && v.captions.length > 0) captionsArr = v.captions
      if (Array.isArray(v.images)) for (const im of v.images) if (im?.url) photoUrls.push(im.url)
      if (!textPostBundle && v.is_text_post && v.per_platform && typeof v.per_platform === 'object') {
        textPostBundle = v.per_platform
      }
    }

    const isTextPost = !!textPostBundle && !videos.length && !singleVideoUrl && !photoUrls.length

    // ── MULTI-CLIP FAN-OUT ─────────────────────────────────────────────
    // When polish emitted videos[] (and ideally caption_gen emitted
    // captions[]), submit ONE Upload-Post job per clip with its own
    // caption set. Each call uses scheduling_mode='auto' so the server
    // picks the next free slot from the brand's posting_schedule —
    // because we submit serially and each post creates a `scheduled`
    // row before the next call runs, /api/social/upload-post's slot
    // picker sees the prior post as "taken" and steps to the next slot
    // naturally. Result: 10 clips spread across the brand's next 10
    // posting times.
    if (videos.length > 1) {
      const results = []
      let okCount = 0
      let failCount = 0

      // Find a caption set for each clip. Prefer idx match (caption_gen
      // stamps an idx onto each set so order isn't fragile), fall back
      // to array position so users without caption_gen fan-out still
      // get the canonical caption on every post.
      const captionFor = (idx) => {
        if (!captionsArr) {
          return { title, caption, hashtags, first_comment: firstComment }
        }
        const c = captionsArr.find((x) => x?.idx === idx) || captionsArr[idx]
        if (!c) return { title, caption, hashtags, first_comment: firstComment }
        return {
          title:         c.title         || title,
          caption:       c.caption       || caption,
          hashtags:      c.hashtags      || hashtags,
          first_comment: c.first_comment || firstComment,
        }
      }

      // Serialize submissions so each /api/social/upload-post call sees
      // the prior post's `scheduled` row when computing the next slot.
      // Parallelizing would race the slot picker and cause two clips to
      // land on the same time.
      for (let i = 0; i < videos.length; i++) {
        const v = videos[i]
        const url = v?.video_url || v?.url
        if (!url) {
          failCount++
          results.push({ idx: i, ok: false, error: 'no video_url' })
          continue
        }
        const c = captionFor(v?.idx ?? i)
        const description = [c.caption, c.hashtags].filter(Boolean).join('\n\n').trim()
          || String(script || '').slice(0, 500)
        try {
          const body = await callApi('/api/social/upload-post', {
            profile_id: ctx.profileId,
            platforms,
            video_url: url,
            description,
            title:         c.title,
            caption:       c.caption,
            hashtags:      c.hashtags,
            script,
            first_comment: c.first_comment,
            scheduling_mode: 'auto',
          }, ctx.headers)
          okCount++
          results.push({
            idx: i,
            ok: true,
            request_id: body?.request_id || null,
            scheduled_iso: body?.scheduled_iso || null,
            video_url: url,
          })
        } catch (e) {
          failCount++
          console.warn(`[schedule_post] clip ${i} failed: ${e?.message}`)
          results.push({ idx: i, ok: false, error: e?.message || String(e), video_url: url })
        }
      }

      if (!okCount) {
        throw new Error(`All ${videos.length} clips failed to schedule: ${results.slice(0, 2).map((r) => r.error).filter(Boolean).join('; ')}`)
      }

      return {
        submitted: okCount,
        failed: failCount,
        scheduled_count: okCount,
        clips: results,
        platforms,
      }
    }

    // ── SINGLE-POST PATH ───────────────────────────────────────────────
    const videoUrl = videos.length === 1 ? (videos[0]?.video_url || videos[0]?.url || singleVideoUrl) : singleVideoUrl
    if (!isTextPost && !videoUrl && !photoUrls.length) {
      throw new Error('schedule_post needs upstream video, images, or a text-post bundle')
    }
    const description = [caption, hashtags].filter(Boolean).join('\n\n').trim() || String(script || '').slice(0, 500)
    const body = await callApi('/api/social/upload-post', {
      profile_id: ctx.profileId,
      platforms,
      video_url: videoUrl || undefined,
      photo_urls: !videoUrl && photoUrls.length ? photoUrls : undefined,
      description,
      title,
      caption,
      hashtags,
      script,
      first_comment: firstComment,
      is_text_post: isTextPost || undefined,
      per_platform_text: textPostBundle || undefined,
      // Server runs always auto-schedule into the next open slot.
      scheduling_mode: 'auto',
    }, ctx.headers)
    return {
      request_id: body.request_id || null,
      scheduled_iso: body.scheduled_iso || null,
      platforms,
      submitted: true,
    }
  },

  save_library: ({ inputs }) => {
    // Same in-memory bundler the browser uses — just passes a
    // bundle downstream. The real persistence happens via
    // schedule_post.
    let title = '', script = '', caption = '', hashtags = '', firstComment = ''
    let videoUrl = null
    const images = []
    for (const v of asArr(inputs)) {
      if (!v || typeof v !== 'object') continue
      if (!title && v.title) title = v.title
      if (!script && (v.script || v.full_script)) script = v.script || v.full_script
      if (!caption && v.caption) caption = v.caption
      if (!hashtags && v.hashtags) hashtags = v.hashtags
      if (!firstComment && v.first_comment) firstComment = v.first_comment
      if (!videoUrl && (v.video?.video_url || v.video_url)) videoUrl = v.video?.video_url || v.video_url
      if (Array.isArray(v.images)) for (const im of v.images) if (im?.url) images.push({ url: im.url })
    }
    const mediaUrls = videoUrl ? [videoUrl] : (images.length ? images.map((i) => i.url) : null)
    return {
      bundle: true,
      title, script, full_script: script, caption, hashtags, first_comment: firstComment,
      video_url: videoUrl,
      images: images.length ? images : undefined,
      media_urls: mediaUrls,
      media_type: videoUrl ? 'video' : (images.length ? 'image' : 'text'),
    }
  },
}

// Topological sort + execute. Inputs into each node come from the
// outputs of every node with an edge pointing TO this node.
export async function runWorkflow({ graph, userId, profileId, internalSecret, log, onProgress, shouldAbort }) {
  const nodes = graph?.nodes || []
  const edges = graph?.edges || []
  const incoming = new Map()
  for (const e of edges) {
    if (!incoming.has(e.target)) incoming.set(e.target, [])
    incoming.get(e.target).push(e)
  }

  // Topo order via Kahn's algorithm.
  const inDegree = new Map(nodes.map((n) => [n.id, 0]))
  for (const e of edges) inDegree.set(e.target, (inDegree.get(e.target) || 0) + 1)
  const queue = nodes.filter((n) => (inDegree.get(n.id) || 0) === 0).map((n) => n.id)
  const order = []
  while (queue.length) {
    const id = queue.shift()
    order.push(id)
    for (const e of edges.filter((e) => e.source === id)) {
      const d = (inDegree.get(e.target) || 0) - 1
      inDegree.set(e.target, d)
      if (d === 0) queue.push(e.target)
    }
  }
  if (order.length !== nodes.length) {
    throw new Error('Workflow has a cycle — fix the graph on the canvas')
  }

  const outputs = new Map()
  const errors = {}
  const headers = makeHeaders({ userId, internalSecret })
  const ctx = { userId, profileId, headers, internalSecret }

  for (const id of order) {
    // Cancellation check at each node boundary. shouldAbort() polls the
    // space_runs row for status='cancelled' (the worker passes a polling
    // function from index.js). If the user clicked Stop, every remaining
    // node short-circuits with the same "cancelled" message instead of
    // chugging through the rest of the graph.
    if (typeof shouldAbort === 'function') {
      let aborted = false
      try { aborted = !!(await shouldAbort()) } catch {}
      if (aborted) {
        errors[id] = 'Cancelled by user'
        try { await onProgress?.(id, { status: 'failed', error: 'Cancelled by user', finished_at: new Date().toISOString() }) } catch {}
        continue
      }
    }
    const node = nodes.find((n) => n.id === id)
    if (!node) continue
    const type = node.data?.type
    const runner = NODE_RUNNERS[type]

    // Pull upstream outputs into an input bag.
    const inputBag = (incoming.get(id) || []).map((e) => outputs.get(e.source)).filter(Boolean)

    // Poison check: if any ancestor errored, skip this node and
    // mark it as ancestor-failed. Matches the browser runtime.
    const ancestorFailed = (incoming.get(id) || []).some((e) => errors[e.source])
    if (ancestorFailed) {
      errors[id] = `Blocked by upstream failure`
      try { await onProgress?.(id, { status: 'failed', error: 'Blocked by upstream failure', finished_at: new Date().toISOString() }) } catch {}
      continue
    }

    if (!runner) {
      // Unsupported node type — fail gracefully. The user can flip
      // off server-run for this space and run it manually, or we
      // add the runner later.
      errors[id] = `Server runs don't support node type "${type}" yet`
      log?.(`[skip] ${id} (${type}): unsupported`)
      try { await onProgress?.(id, { status: 'failed', error: errors[id], finished_at: new Date().toISOString() }) } catch {}
      continue
    }

    try {
      log?.(`[run]  ${id} (${type})`)
      try { await onProgress?.(id, { status: 'running', started_at: new Date().toISOString() }) } catch {}
      const out = await runner({ node, inputs: inputBag, ctx, log: (m) => log?.(`  ${m}`) })
      outputs.set(id, out || {})
      log?.(`[done] ${id}`)
      // Send the output too so the browser can hydrate node.data.output
      // and let the user re-run downstream nodes (e.g., re-polish with
      // a different title) without redoing the upstream chain.
      try { await onProgress?.(id, { status: 'success', finished_at: new Date().toISOString(), output: out || {} }) } catch {}
    } catch (err) {
      errors[id] = err.message || String(err)
      log?.(`[fail] ${id} (${type}): ${errors[id]}`)
      try { await onProgress?.(id, { status: 'failed', error: errors[id], finished_at: new Date().toISOString() }) } catch {}
    }
  }

  return {
    ok: Object.keys(errors).length === 0,
    errors,
    output_count: outputs.size,
  }
}
