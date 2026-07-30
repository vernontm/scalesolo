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

import { readFile } from 'node:fs/promises'
import { basename, extname } from 'node:path'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js'

const API_BASE = (process.env.SCALESOLO_API_BASE || 'https://scalesolo.ai').replace(/\/$/, '')
const SECRET = process.env.SCALESOLO_INTERNAL_SECRET
const USER_ID = process.env.SCALESOLO_USER_ID
if (!SECRET || !USER_ID) {
  console.error('scalesolo-mcp: SCALESOLO_INTERNAL_SECRET and SCALESOLO_USER_ID are required')
  process.exit(1)
}

const VIDEO_EXT = new Set(['mp4', 'mov', 'webm', 'm4v'])
const MIME = {
  mp4: 'video/mp4', mov: 'video/quicktime', webm: 'video/webm', m4v: 'video/x-m4v',
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', webp: 'image/webp', gif: 'image/gif',
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

// ── Tool implementations ─────────────────────────────────────────────
const impls = {
  async list_brands() {
    const { profiles } = await api('/api/profiles')
    return ok((profiles || []).map((p) => ({ id: p.id, name: p.business_name, uploadpost_user: p.uploadpost_user || null })))
  },

  async upload_media({ brand, file_path }) {
    if (!file_path) throw new Error('file_path is required')
    const profile = await resolveBrand(brand)
    const ext = extname(file_path).slice(1).toLowerCase()
    const kind = VIDEO_EXT.has(ext) ? 'video' : 'image'
    const contentType = MIME[ext] || (kind === 'video' ? 'video/mp4' : 'image/jpeg')
    const bytes = await readFile(file_path)

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
    if (!put.ok) throw new Error(`Storage upload failed (${put.status}): ${(await put.text()).slice(0, 200)}`)
    // 3. create the draft content row
    const created = await api('/api/content', {
      method: 'POST',
      json: {
        profile_id: profile.id,
        title: basename(file_path).replace(/\.[^.]+$/, '').slice(0, 80),
        media_urls: [init.public_url], media_type: init.media_type,
        post_type: init.media_type === 'video' ? 'video' : 'post',
        status: 'draft', generated_by: 'mcp',
      },
    })
    const id = created?.item?.id
    if (!id) throw new Error('Row created but no id returned')
    return ok({ content_id: id, brand: profile.business_name, media_type: init.media_type, media_url: init.public_url })
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

  // CONFIRM GATE — the only tool that reaches Upload-Post. Sets the chosen
  // slot then approves the post, which submits it to Upload-Post for that
  // time. Call this ONLY after the user has explicitly confirmed.
  async schedule_post({ content_id, scheduled_datetime }) {
    if (!content_id) throw new Error('content_id is required')
    if (!scheduled_datetime) throw new Error('scheduled_datetime (ISO) is required')
    // 1. pin the slot
    await api('/api/content', { method: 'PATCH', query: { id: content_id }, json: { scheduled_datetime } })
    // 2. approve → schedules + submits to Upload-Post (first-time submit path)
    const res = await api('/api/content', { method: 'POST', query: { action: 'approve', id: content_id } })
    const row = res?.item || {}
    return ok({
      content_id,
      status: row.status || 'scheduled',
      scheduled_datetime: row.scheduled_datetime || scheduled_datetime,
      uploadpost_request_id: row.uploadpost_request_id || res?.request_id || null,
      submitted_to_upload_post: !!(row.uploadpost_request_id || res?.request_id),
    })
  },
}

// ── Tool schemas ─────────────────────────────────────────────────────
const TOOLS = [
  { name: 'list_brands', description: 'List the ScaleSolo brand profiles you can post for (id, name, Upload-Post handle).', inputSchema: { type: 'object', properties: {} } },
  { name: 'upload_media', description: 'Upload a local video or image file to ScaleSolo under a brand and create a draft post. Returns a content_id. Does NOT publish.', inputSchema: { type: 'object', properties: { brand: { type: 'string', description: 'Brand name, Upload-Post handle, or profile id (e.g. "RayvaughnCEO").' }, file_path: { type: 'string', description: 'Absolute path to the local video/image file.' } }, required: ['brand', 'file_path'] } },
  { name: 'autocaption', description: 'Run ScaleSolo autopilot on an uploaded post: analyze the media and generate a title, caption, and hashtags. Returns them for review. Does NOT publish.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' } }, required: ['content_id'] } },
  { name: 'next_slots', description: "List the next open posting time slots from a brand's posting schedule (ISO + human-readable local time).", inputSchema: { type: 'object', properties: { brand: { type: 'string' }, count: { type: 'number', description: 'How many slots (default 5).' } }, required: ['brand'] } },
  { name: 'get_post', description: 'Read a draft/scheduled post (title, caption, hashtags, media, platforms, slot) for review.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' } }, required: ['content_id'] } },
  { name: 'update_post', description: 'Apply edits to a post\'s title / caption / hashtags / first_comment before scheduling. Does NOT publish.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' }, title: { type: 'string' }, caption: { type: 'string' }, hashtags: { type: 'string' }, first_comment: { type: 'string' } }, required: ['content_id'] } },
  { name: 'schedule_post', description: 'PUBLISHES/SCHEDULES the post to social via Upload-Post at the given time. This is the only tool that posts to social — call it ONLY after the user has explicitly confirmed the caption and the chosen slot.', inputSchema: { type: 'object', properties: { content_id: { type: 'string' }, scheduled_datetime: { type: 'string', description: 'ISO 8601 datetime (use an iso value from next_slots).' } }, required: ['content_id', 'scheduled_datetime'] } },
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
