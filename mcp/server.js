#!/usr/bin/env node
// ScaleSolo MCP server (stdio).
//
// Lets an MCP client (Claude) drive ScaleSolo's posting pipeline for a
// chosen brand: upload a video/image -> auto-caption (title/caption/
// hashtags) -> see the next open time slots -> review/edit -> schedule.
//
// Safety: NOTHING is published or scheduled to social automatically. Only
// `schedule_post` reaches Upload-Post, and it is meant to be called by the
// model ONLY after the user has explicitly confirmed the caption + slot.
//
// Auth: reuses ScaleSolo's internal-secret impersonation (the same path
// the Fly worker uses). Every request carries:
//   x-internal-secret: <SCALESOLO_INTERNAL_SECRET>   (= Vercel WORKFLOW_INTERNAL_SECRET)
//   x-impersonate-user: <SCALESOLO_USER_ID>
// The secret lives only in this server's env — never committed.
//
// Env:
//   SCALESOLO_API_BASE       e.g. https://scalesolo.ai
//   SCALESOLO_INTERNAL_SECRET
//   SCALESOLO_USER_ID        the ScaleSolo auth user to act as

import { readFile, readdir, unlink } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

// Use the www host: the apex scalesolo.ai 307-redirects and curl/fetch drop
// custom headers across the redirect, which would break impersonation auth.
const API_BASE = (process.env.SCALESOLO_API_BASE || 'https://www.scalesolo.ai').replace(/\/$/, '')
const SECRET = process.env.SCALESOLO_INTERNAL_SECRET
const USER_ID = process.env.SCALESOLO_USER_ID
if (!SECRET || !USER_ID) {
  console.error('scalesolo-mcp: SCALESOLO_INTERNAL_SECRET and SCALESOLO_USER_ID are required')
  process.exit(1)
}

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v'])
const IMAGE_EXT = new Set(['jpg', 'jpeg', 'png', 'webp', 'gif'])
const MIME = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
}

// ── Ensure a video is H.264 ──────────────────────────────────────────
// TikTok's app errors on HEVC/H.265 drafts (and some other codecs), so any
// non-H.264 video is transcoded to H.264 + AAC + faststart before upload.
// Needs ffmpeg/ffprobe on PATH; if they're missing we upload as-is (with a
// note) rather than failing the whole upload. Returns { path, transcoded, note? }.
function videoCodec(path) {
  try {
    return execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0',
      '-show_entries', 'stream=codec_name', '-of', 'default=nw=1:nk=1', path],
      { encoding: 'utf8', timeout: 30000 }).trim().toLowerCase()
  } catch { return null }
}
function ensureH264(path) {
  const codec = videoCodec(path)
  if (codec === null) return { path, transcoded: false, note: 'ffmpeg/ffprobe not found — uploaded as-is (transcode skipped)' }
  if (codec === 'h264') return { path, transcoded: false }
  const out = join(tmpdir(), `ss-h264-${Date.now()}-${basename(path).replace(/\.[^.]+$/, '')}.mp4`)
  try {
    execFileSync('ffmpeg', ['-y', '-i', path,
      '-c:v', 'libx264', '-profile:v', 'high', '-pix_fmt', 'yuv420p', '-crf', '20', '-preset', 'veryfast',
      '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', out],
      { timeout: 900000, stdio: 'ignore' })
    return { path: out, transcoded: true, from: codec }
  } catch (e) {
    return { path, transcoded: false, note: `transcode failed (${e.message.slice(0, 80)}) — uploaded as-is` }
  }
}

// ── ScaleSolo API helper (adds impersonation headers) ────────────────
async function api(path, { method = 'GET', query, json, headers } = {}) {
  const qs = query ? '?' + new URLSearchParams(query).toString() : ''
  const r = await fetch(`${API_BASE}${path}${qs}`, {
    method,
    headers: {
      'x-internal-secret': SECRET,
      'x-impersonate-user': USER_ID,
      ...(json ? { 'Content-Type': 'application/json' } : {}),
      ...headers,
    },
    body: json ? JSON.stringify(json) : undefined,
  })
  const text = await r.text()
  let body = null
  try { body = text ? JSON.parse(text) : null } catch { body = { raw: text } }
  if (!r.ok) throw new Error(body?.error || `${method} ${path} failed (${r.status}): ${text.slice(0, 200)}`)
  return body
}

// Resolve a brand identifier (business name, uploadpost handle, or id) to
// a profile. Case-insensitive substring match on name/handle.
async function resolveBrand(brand) {
  const { profiles } = await api('/api/profiles')
  const list = profiles || []
  const q = String(brand || '').trim().toLowerCase()
  if (!q) throw new Error('brand is required')
  const hit = list.find((p) => p.id === brand)
    || list.find((p) => String(p.business_name || '').toLowerCase() === q || String(p.uploadpost_user || '').toLowerCase() === q)
    || list.find((p) => String(p.business_name || '').toLowerCase().includes(q) || String(p.uploadpost_user || '').toLowerCase().includes(q))
  if (!hit) throw new Error(`No brand matched "${brand}". Available: ${list.map((p) => p.business_name).join(', ')}`)
  return hit
}

const ok = (obj) => ({ content: [{ type: 'text', text: JSON.stringify(obj, null, 2) }] })

// Normalize platform names to what the system stores ("x", not "twitter").
const PLATFORM_ALIASES = { twitter: 'x' }
const normPlatforms = (arr) => (Array.isArray(arr) ? arr : [])
  .map((p) => String(p || '').trim().toLowerCase())
  .map((p) => PLATFORM_ALIASES[p] || p)
  .filter(Boolean)

// The platforms a new post for this brand should default to: the brand's
// configured default_platforms if set, otherwise all connected platforms.
async function connectedPlatforms(profileId) {
  try {
    const b = await api('/api/account/uploadpost-connected', { query: { profile_id: profileId } })
    if (Array.isArray(b?.default_platforms) && b.default_platforms.length) return normPlatforms(b.default_platforms)
    return normPlatforms(b?.connected_platforms)
  } catch { return [] }
}

// ── Tool implementations ─────────────────────────────────────────────
const impls = {
  async list_brands() {
    const { profiles } = await api('/api/profiles')
    const out = await Promise.all((profiles || []).map(async (p) => ({
      id: p.id, name: p.business_name, uploadpost_user: p.uploadpost_user || null,
      connected_platforms: await connectedPlatforms(p.id),
    })))
    return ok(out)
  },

  async upload_media({ brand, file_path, platforms }) {
    if (!file_path) throw new Error('file_path is required')
    const profile = await resolveBrand(brand)
    const ext = extname(file_path).slice(1).toLowerCase()
    const kind = VIDEO_EXT.has(ext) ? 'video' : 'image'
    let contentType = MIME[ext] || (kind === 'video' ? 'video/mp4' : 'image/jpeg')

    // Videos: make sure it's H.264 (TikTok drafts choke on HEVC). Transcode
    // to a temp file if needed; upload that instead of the original.
    let uploadPath = file_path
    let transcodeNote = null
    if (kind === 'video') {
      const t = ensureH264(file_path)
      uploadPath = t.path
      if (t.transcoded) { contentType = 'video/mp4'; transcodeNote = `transcoded ${t.from} → h264 for TikTok compatibility` }
      else if (t.note) { transcodeNote = t.note }
    }
    const bytes = await readFile(uploadPath)

    // 1. init signed URL
    const init = await api('/api/content/upload-media', {
      method: 'POST', query: { mode: 'init' },
      json: { profile_id: profile.id, content_type: contentType, kind },
    })
    // 2. PUT the bytes straight to storage
    const put = await fetch(init.signed_url, {
      method: 'PUT',
      headers: { Authorization: `Bearer ${init.token}`, 'Content-Type': contentType, 'x-upsert': 'true' },
      body: bytes,
    })
    // Clean up the temp transcode regardless of upload outcome.
    if (uploadPath !== file_path) { try { await unlink(uploadPath) } catch {} }
    if (!put.ok) throw new Error(`Storage upload failed (${put.status}): ${(await put.text()).slice(0, 200)}`)
    // Platforms: use what was passed, else default to the brand's connected set.
    const chosen = platforms?.length ? normPlatforms(platforms) : await connectedPlatforms(profile.id)
    // 3. create the draft content row
    const created = await api('/api/content', {
      method: 'POST',
      json: {
        profile_id: profile.id,
        title: basename(file_path).replace(/\.[^.]+$/, '').slice(0, 80),
        media_urls: [init.public_url], media_type: init.media_type,
        post_type: init.media_type === 'video' ? 'video' : 'post',
        status: 'draft', generated_by: 'mcp',
        platforms: chosen.length ? chosen : null,
      },
    })
    const id = created?.item?.id
    if (!id) throw new Error('Row created but no id returned')
    return ok({ content_id: id, brand: profile.business_name, media_type: init.media_type, media_url: init.public_url, platforms: chosen, ...(transcodeNote ? { transcode: transcodeNote } : {}) })
  },

  async autocaption({ content_id }) {
    if (!content_id) throw new Error('content_id is required')
    const row = (await api('/api/content', { query: { id: content_id } }))?.item
    if (!row) throw new Error('post not found')
    await api('/api/content/bulk-actions', {
      method: 'POST', query: { action: 'generate-captions' },
      json: { profile_id: row.profile_id, script_ids: [content_id] },
    })
    const updated = (await api('/api/content', { query: { id: content_id } }))?.item || {}
    return ok({
      content_id,
      title: updated.title || null,
      caption: updated.caption || null,
      hashtags: updated.hashtags || null,
      first_comment: updated.first_comment || null,
    })
  },

  // One-shot: upload + auto-caption, then STOP (no scheduling). The post
  // lands in the calendar's "Waiting to schedule" backlog for that brand,
  // where the user drags it onto an open slot. This never posts anything.
  async add_to_backlog({ brand, file_path, platforms }) {
    const up = JSON.parse((await impls.upload_media({ brand, file_path, platforms })).content[0].text)
    let cap = {}
    try {
      cap = JSON.parse((await impls.autocaption({ content_id: up.content_id })).content[0].text)
    } catch (e) {
      cap = { caption_warning: `Auto-caption failed (${e.message}); edit the post manually.` }
    }
    return ok({
      content_id: up.content_id,
      brand: up.brand,
      media_type: up.media_type,
      platforms: up.platforms,
      title: cap.title || null,
      caption: cap.caption || null,
      hashtags: cap.hashtags || null,
      status: 'waiting to schedule (in the calendar backlog)',
      next: `Open the ${up.brand} calendar and drag this onto an open slot, or call schedule_post to schedule it from here.`,
      ...(cap.caption_warning ? { caption_warning: cap.caption_warning } : {}),
    })
  },

  // Batch: turn MANY local files into SEPARATE backlog posts in one call —
  // each file becomes its own upload + auto-caption, left unscheduled in the
  // brand's "Waiting to schedule" backlog. Accepts an explicit file_paths
  // list and/or a folder (all media files in it). Runs sequentially and
  // keeps going past any single failure, reporting per-file results. Never
  // posts or schedules anything. (For a single multi-image carousel, use
  // upload_carousel instead — that makes ONE post, not many.)
  async batch_add_to_backlog({ brand, file_paths, folder, platforms }) {
    const profile = await resolveBrand(brand)
    let files = Array.isArray(file_paths) ? file_paths.filter(Boolean) : []
    if (folder) {
      let entries
      try { entries = await readdir(folder) }
      catch (e) { throw new Error(`Could not read folder "${folder}": ${e.message}`) }
      const media = entries
        .filter((n) => { const e = extname(n).slice(1).toLowerCase(); return VIDEO_EXT.has(e) || IMAGE_EXT.has(e) })
        .sort()
        .map((n) => join(folder, n))
      // De-dupe against any explicit paths pointing at the same files.
      for (const m of media) if (!files.includes(m)) files.push(m)
    }
    if (!files.length) throw new Error('No files to upload. Pass file_paths (array) and/or folder (a directory of media).')
    if (files.length > 50) throw new Error(`Too many files (${files.length}). Batch is capped at 50 per call.`)

    const posts = []
    for (const fp of files) {
      try {
        // Pass the resolved profile id so each item skips the name lookup.
        const r = JSON.parse((await impls.add_to_backlog({ brand: profile.id, file_path: fp, platforms })).content[0].text)
        posts.push({
          file: fp, status: 'ok', content_id: r.content_id, media_type: r.media_type,
          title: r.title, caption: r.caption, hashtags: r.hashtags, platforms: r.platforms,
          ...(r.caption_warning ? { caption_warning: r.caption_warning } : {}),
        })
      } catch (e) {
        posts.push({ file: fp, status: 'failed', error: e.message })
      }
    }
    const uploaded = posts.filter((p) => p.status === 'ok').length
    return ok({
      brand: profile.business_name,
      total: posts.length,
      uploaded,
      failed: posts.length - uploaded,
      posts,
      status: 'waiting to schedule (in the calendar backlog)',
      next: `${uploaded} post(s) are in the ${profile.business_name} "Waiting to schedule" backlog. Open the calendar and drag each onto an open slot, or call schedule_post per content_id.`,
    })
  },

  // Make ONE carousel post from several images, caption it, and leave it
  // unscheduled in the backlog. Posts as a photo carousel (incl. TikTok
  // photo mode) when scheduled. Images only — no videos in a carousel.
  async upload_carousel({ brand, file_paths, platforms }) {
    if (!Array.isArray(file_paths) || file_paths.length < 2) {
      throw new Error('Provide at least 2 image file paths for a carousel.')
    }
    if (file_paths.length > 35) throw new Error('Carousels support at most 35 images.')
    const profile = await resolveBrand(brand)
    const urls = []
    for (const fp of file_paths) {
      const ext = extname(fp).slice(1).toLowerCase()
      if (VIDEO_EXT.has(ext)) throw new Error(`Carousels are images only; "${fp}" looks like a video.`)
      const contentType = MIME[ext] || 'image/jpeg'
      const bytes = await readFile(fp)
      const init = await api('/api/content/upload-media', {
        method: 'POST', query: { mode: 'init' },
        json: { profile_id: profile.id, content_type: contentType, kind: 'image' },
      })
      const put = await fetch(init.signed_url, {
        method: 'PUT',
        headers: { Authorization: `Bearer ${init.token}`, 'Content-Type': contentType, 'x-upsert': 'true' },
        body: bytes,
      })
      if (!put.ok) throw new Error(`Storage upload failed for "${fp}" (${put.status})`)
      urls.push(init.public_url)
    }
    const chosen = platforms?.length ? normPlatforms(platforms) : await connectedPlatforms(profile.id)
    const created = await api('/api/content', {
      method: 'POST',
      json: {
        profile_id: profile.id,
        title: basename(file_paths[0]).replace(/\.[^.]+$/, '').slice(0, 80),
        media_urls: urls, media_type: 'carousel', post_type: 'post',
        status: 'draft', generated_by: 'mcp',
        platforms: chosen.length ? chosen : null,
      },
    })
    const id = created?.item?.id
    if (!id) throw new Error('Row created but no id returned')
    let cap = {}
    try { cap = JSON.parse((await impls.autocaption({ content_id: id })).content[0].text) }
    catch (e) { cap = { caption_warning: `Auto-caption failed (${e.message}); edit the post manually.` } }
    return ok({
      content_id: id, brand: profile.business_name, media_type: 'carousel',
      slides: urls.length, platforms: chosen,
      title: cap.title || null, caption: cap.caption || null, hashtags: cap.hashtags || null,
      status: 'waiting to schedule (in the calendar backlog)',
      next: `Open the ${profile.business_name} calendar and drag this onto an open slot, or call schedule_post.`,
      ...(cap.caption_warning ? { caption_warning: cap.caption_warning } : {}),
    })
  },

  // Generate image(s) with AI (KIE.ai / nano-banana etc.), billed to the
  // brand owner's ScaleSolo credits (~4,000 ai_tokens per image). The generate
  // endpoint reserves credits up-front and returns 402 if the balance is too
  // low, so this tool can't spend credits the user doesn't have. Returns the
  // finished image URLs; optionally drops them into the calendar backlog as a
  // draft post (add_to_backlog).
  async generate_image({ brand, prompt, count = 1, aspect = '1:1', model = 'nano-banana', reference_urls, enhance_prompt = false, add_to_backlog: alsoBacklog = false, platforms }) {
    if (!prompt) throw new Error('prompt is required')
    const profile = await resolveBrand(brand)
    const n = Math.max(1, Math.min(8, Number(count) || 1))
    let sub
    try {
      sub = await api('/api/images/generate', {
        method: 'POST',
        json: {
          profile_id: profile.id, prompt, model, count: n, aspect,
          reference_urls: (Array.isArray(reference_urls) && reference_urls.length) ? reference_urls : undefined,
          enhance_prompt: !!enhance_prompt,
        },
      })
    } catch (e) {
      if (/insufficient|not enough|402/i.test(e.message)) {
        throw new Error(`Not enough ScaleSolo credits to generate ${n} image(s) (~${4000 * n} ai_tokens needed). ${e.message}`)
      }
      throw e
    }
    const taskId = sub?.taskId
    if (!taskId) throw new Error('Image generation did not start (no taskId).')

    // Poll for results (~4 min ceiling; images usually land in 5-30s).
    let urls = []
    for (let i = 0; i < 80; i++) {
      await new Promise((r) => setTimeout(r, 3000))
      let st
      try { st = await api('/api/images/status', { query: { taskId, profile_id: profile.id } }) }
      catch { continue }
      const got = (Array.isArray(st?.urls) ? st.urls : Array.isArray(st?.images) ? st.images : [])
        .map((u) => (typeof u === 'string' ? u : u?.url)).filter(Boolean)
      if (got.length) { urls = got; break }
      if (String(st?.state || '').toLowerCase() === 'failed') throw new Error(st?.error || 'Image generation failed at KIE.')
    }
    if (!urls.length) throw new Error('Image generation timed out (no images after ~4 min).')

    const result = { brand: profile.business_name, model, prompt, count: urls.length, images: urls }
    if (alsoBacklog) {
      const chosen = platforms?.length ? normPlatforms(platforms) : await connectedPlatforms(profile.id)
      const created = await api('/api/content', {
        method: 'POST',
        json: {
          profile_id: profile.id, title: String(prompt).slice(0, 80),
          media_urls: urls, media_type: urls.length > 1 ? 'carousel' : 'image', post_type: 'post',
          status: 'draft', generated_by: 'mcp', platforms: chosen.length ? chosen : null,
        },
      })
      const id = created?.item?.id
      if (id) {
        result.content_id = id
        try {
          const cap = JSON.parse((await impls.autocaption({ content_id: id })).content[0].text)
          result.title = cap.title || null; result.caption = cap.caption || null; result.hashtags = cap.hashtags || null
        } catch { /* caption is best-effort */ }
        result.status = 'waiting to schedule (in the calendar backlog)'
      }
    }
    return ok(result)
  },

  async next_slots({ brand, count }) {
    const profile = await resolveBrand(brand)
    const body = await api('/api/content/next-slots', {
      query: { profile_id: profile.id, count: String(count || 5) },
    })
    return ok({ brand: profile.business_name, timezone: body.timezone, slots: body.slots })
  },

  async get_post({ content_id }) {
    if (!content_id) throw new Error('content_id is required')
    const row = (await api('/api/content', { query: { id: content_id } }))?.item
    if (!row) throw new Error('post not found')
    return ok({
      content_id, title: row.title, caption: row.caption, hashtags: row.hashtags,
      first_comment: row.first_comment, media_type: row.media_type, media_urls: row.media_urls,
      platforms: row.platforms, status: row.status, scheduled_datetime: row.scheduled_datetime,
    })
  },

  async update_post({ content_id, title, caption, hashtags, first_comment }) {
    if (!content_id) throw new Error('content_id is required')
    const patch = {}
    if (title !== undefined) patch.title = title
    if (caption !== undefined) patch.caption = caption
    if (hashtags !== undefined) patch.hashtags = hashtags
    if (first_comment !== undefined) patch.first_comment = first_comment
    if (!Object.keys(patch).length) throw new Error('nothing to update')
    const updated = await api('/api/content', { method: 'PATCH', query: { id: content_id }, json: patch })
    const row = updated?.item || updated
    return ok({ content_id, title: row.title, caption: row.caption, hashtags: row.hashtags, first_comment: row.first_comment })
  },

  async set_platforms({ content_id, platforms }) {
    if (!content_id) throw new Error('content_id is required')
    const list = normPlatforms(platforms)
    if (!list.length) throw new Error('platforms must be a non-empty list, e.g. ["instagram","tiktok"]')
    const updated = await api('/api/content', { method: 'PATCH', query: { id: content_id }, json: { platforms: list } })
    const row = updated?.item || updated
    return ok({ content_id, platforms: row.platforms })
  },

  // CONFIRM GATE — the only tool that reaches Upload-Post. Sets the chosen
  // slot (and platforms, if given) then approves the post, which submits it
  // to Upload-Post for that time. Call this ONLY after the user has
  // explicitly confirmed the caption, the platforms, and the slot.
  async schedule_post({ content_id, scheduled_datetime, platforms }) {
    if (!content_id) throw new Error('content_id is required')
    if (!scheduled_datetime) throw new Error('scheduled_datetime (ISO) is required')
    // Resolve the target platforms: passed in > already on the row >
    // the brand's connected set. Refuse to schedule with none, or the
    // publish step would silently no-op.
    const row0 = (await api('/api/content', { query: { id: content_id } }))?.item
    if (!row0) throw new Error('post not found')
    let targets = normPlatforms(platforms)
    if (!targets.length) targets = normPlatforms(row0.platforms)
    if (!targets.length) targets = await connectedPlatforms(row0.profile_id)
    if (!targets.length) throw new Error('No platforms selected and none connected for this brand. Pass platforms, e.g. ["instagram","tiktok"].')
    // 1. pin the slot + platforms
    await api('/api/content', { method: 'PATCH', query: { id: content_id }, json: { scheduled_datetime, platforms: targets } })
    // 2. approve → schedules + submits to Upload-Post (first-time submit path)
    const res = await api('/api/content', { method: 'POST', query: { action: 'approve', id: content_id } })
    const row = res?.item || {}
    return ok({
      content_id,
      status: row.status || 'scheduled',
      platforms: row.platforms || targets,
      scheduled_datetime: row.scheduled_datetime || scheduled_datetime,
      uploadpost_request_id: row.uploadpost_request_id || res?.request_id || null,
      submitted_to_upload_post: !!(row.uploadpost_request_id || res?.request_id),
    })
  },

  // CONFIRM GATE — publishes RIGHT NOW, no scheduler wait. Submits the post to
  // Upload-Post immediately (cancels any pending scheduled job first so it
  // can't double-post). For a brand in TikTok Draft mode this lands in the
  // TikTok inbox/drafts instantly instead of the feed. Call ONLY after the
  // user has explicitly confirmed the caption + platforms.
  async post_now({ content_id, platforms }) {
    if (!content_id) throw new Error('content_id is required')
    const row0 = (await api('/api/content', { query: { id: content_id } }))?.item
    if (!row0) throw new Error('post not found')
    // If platforms passed, set them on the row first so publish uses them.
    let targets = normPlatforms(platforms)
    if (!targets.length) targets = normPlatforms(row0.platforms)
    if (!targets.length) targets = await connectedPlatforms(row0.profile_id)
    if (!targets.length) throw new Error('No platforms selected and none connected for this brand. Pass platforms, e.g. ["tiktok"].')
    if (Array.isArray(platforms) && platforms.length) {
      await api('/api/content', { method: 'PATCH', query: { id: content_id }, json: { platforms: targets } })
    }
    // publish-selected submits to Upload-Post immediately (no scheduled_date).
    const res = await api('/api/content/bulk-actions', {
      method: 'POST', query: { action: 'publish-selected' },
      json: { profile_id: row0.profile_id, script_ids: [content_id] },
    })
    const result = Array.isArray(res?.results) ? res.results.find((x) => x.id === content_id) : null
    if (result && result.ok === false) {
      throw new Error(result.error || 'Publish failed at Upload-Post')
    }
    const row = (await api('/api/content', { query: { id: content_id } }))?.item || {}
    return ok({
      content_id,
      status: row.status || 'posted',
      platforms: row.platforms || targets,
      posted_now: true,
      uploadpost_request_id: row.uploadpost_request_id || result?.request_id || null,
      note: 'Submitted to Upload-Post immediately. In TikTok Draft mode it lands in the app inbox/drafts now.',
    })
  },
}

// ── Tool schemas ─────────────────────────────────────────────────────
const PLATFORM_VALUES = ['instagram', 'facebook', 'tiktok', 'youtube', 'threads', 'x', 'linkedin', 'pinterest']
const platformsSchema = { type: 'array', items: { type: 'string', enum: PLATFORM_VALUES }, description: 'Which social platforms to post to (use "x" for Twitter/X). Only ones the brand is connected to will actually publish.' }

const TOOLS = [
  { name: 'list_brands', description: 'List the ScaleSolo brand profiles you can post for, each with its Upload-Post handle and the platforms it is connected to (the valid choices for this brand).', inputSchema: { type: 'object', properties: {} } },
  { name: 'upload_media', description: 'Upload a local video or image file to ScaleSolo under a brand and create a draft post. Optionally set target platforms (defaults to the brand\'s connected platforms). Returns a content_id. Does NOT publish.', inputSchema: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name, Upload-Post handle, or profile id (e.g. "RayvaughnCEO").' }, file_path: { type: 'string', description: 'Absolute path to the local video/image file.' }, platforms: platformsSchema }, required: ['brand', 'file_path'] } },
  { name: 'autocaption', description: 'Run ScaleSolo autopilot on an uploaded post: analyze the media and generate a title, caption, and hashtags. Returns them for review. Does NOT publish.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' } }, required: ['content_id'] } },
  { name: 'add_to_backlog', description: 'Upload a local video/image AND auto-caption it in one step, then leave it UNSCHEDULED in the calendar\'s "Waiting to schedule" backlog for that brand. Use this when the user wants a post prepared to drag onto the calendar later. Never posts or schedules anything.', inputSchema: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name, Upload-Post handle, or profile id (e.g. "RayvaughnCEO").' }, file_path: { type: 'string', description: 'Absolute path to the local video/image file.' }, platforms: platformsSchema }, required: ['brand', 'file_path'] } },
  { name: 'batch_add_to_backlog', description: 'Upload MANY local files at once, each becoming its OWN separate post (upload + auto-caption), all left UNSCHEDULED in the brand\'s "Waiting to schedule" backlog. Pass file_paths (a list) and/or folder (a directory whose video/image files are all uploaded). Runs one at a time, continues past failures, and returns a per-file result list. Use this to prep a batch of posts to schedule later. Never posts or schedules anything. (For ONE post made of multiple images, use upload_carousel instead.)', inputSchema: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name, Upload-Post handle, or profile id.' }, file_paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to local video/image files — each becomes its own post.' }, folder: { type: 'string', description: 'Optional absolute path to a directory; all video/image files inside are uploaded (in filename order).' }, platforms: platformsSchema }, required: ['brand'] } },
  { name: 'upload_carousel', description: 'Make ONE carousel post from several local images (2-35), auto-caption it, and leave it UNSCHEDULED in the calendar backlog for that brand. Posts as a photo carousel (including TikTok photo mode) when scheduled. Images only. Never posts or schedules anything.', inputSchema: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name, Upload-Post handle, or profile id.' }, file_paths: { type: 'array', items: { type: 'string' }, description: 'Absolute paths to 2-35 local image files, in slide order.' }, platforms: platformsSchema }, required: ['brand', 'file_paths'] } },
  { name: 'generate_image', description: 'Generate AI image(s) for a brand via KIE.ai (nano-banana / GPT-Image). Billed to the brand owner\'s ScaleSolo credits (~4,000 ai_tokens per image); returns an insufficient-credits error if the balance is too low, so it can never overspend. Returns the finished image URLs. Set add_to_backlog to also drop them into the calendar backlog as a captioned draft post.', inputSchema: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name, Upload-Post handle, or profile id.' }, prompt: { type: 'string', description: 'What to generate.' }, count: { type: 'number', description: '1-8 images (default 1).' }, aspect: { type: 'string', description: 'Aspect ratio, e.g. "1:1", "9:16", "16:9", "4:5" (default "1:1").' }, model: { type: 'string', description: 'nano-banana (default), nano-banana-pro, or gpt-2.' }, reference_urls: { type: 'array', items: { type: 'string' }, description: 'Optional reference image URLs for image-to-image / likeness.' }, enhance_prompt: { type: 'boolean', description: 'Let Claude expand the prompt with composition/lighting first.' }, add_to_backlog: { type: 'boolean', description: 'Also create a captioned draft post from the generated images in the calendar backlog.' }, platforms: platformsSchema }, required: ['brand', 'prompt'] } },
  { name: 'next_slots', description: "List the next open posting time slots from a brand's posting schedule (ISO + human-readable local time).", inputSchema: { type: 'object', properties: { brand: { type: 'string' }, count: { type: 'number', description: 'How many slots (default 5).' } }, required: ['brand'] } },
  { name: 'get_post', description: 'Read a draft/scheduled post (title, caption, hashtags, media, platforms, slot) for review.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' } }, required: ['content_id'] } },
  { name: 'update_post', description: 'Apply edits to a post\'s title / caption / hashtags / first_comment before scheduling. Does NOT publish.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' }, title: { type: 'string' }, caption: { type: 'string' }, hashtags: { type: 'string' }, first_comment: { type: 'string' } }, required: ['content_id'] } },
  { name: 'set_platforms', description: 'Set which social platforms a post will go to. Does NOT publish.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' }, platforms: platformsSchema }, required: ['content_id', 'platforms'] } },
  { name: 'schedule_post', description: 'PUBLISHES/SCHEDULES the post to social via Upload-Post at the given time and platforms. Call it ONLY after the user has explicitly confirmed the caption, the platforms, and the slot. If platforms is omitted it uses the ones already on the post, else the brand\'s connected platforms.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' }, scheduled_datetime: { type: 'string', description: 'ISO 8601 datetime (use an iso value from next_slots).' }, platforms: platformsSchema }, required: ['content_id', 'scheduled_datetime'] } },
  { name: 'post_now', description: 'PUBLISHES the post RIGHT NOW with no scheduler wait — submits to Upload-Post immediately (and cancels any pending scheduled job so it can\'t double-post). For a brand in TikTok Draft mode this lands in the TikTok inbox/drafts instantly. Call ONLY after the user has explicitly confirmed the caption and platforms. Use this instead of schedule_post when the user wants it out immediately rather than at a future slot.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' }, platforms: platformsSchema }, required: ['content_id'] } },
]

// ── Wire up the server ───────────────────────────────────────────────
const server = new Server({ name: 'scalesolo', version: '0.1.0' }, { capabilities: { tools: {} } })

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }))
server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const fn = impls[req.params.name]
  if (!fn) throw new Error(`Unknown tool: ${req.params.name}`)
  try {
    return await fn(req.params.arguments || {})
  } catch (e) {
    return { isError: true, content: [{ type: 'text', text: `Error: ${e?.message || String(e)}` }] }
  }
})

await server.connect(new StdioServerTransport())
console.error(`scalesolo-mcp ready → ${API_BASE} (user ${USER_ID.slice(0, 8)}…)`)
