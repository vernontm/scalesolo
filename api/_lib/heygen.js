// HeyGen REST wrapper + model cost catalog.
// Docs: https://docs.heygen.com/

const BASE_V2 = 'https://api.heygen.com/v2'
const BASE_V1 = 'https://api.heygen.com/v1'
const UPLOAD_BASE = 'https://upload.heygen.com'

function key() {
  const k = process.env.HEYGEN_API_KEY
  if (!k) throw new Error('HEYGEN_API_KEY not set')
  return k
}

const HEADERS = () => ({
  'X-Api-Key': key(),
  'Content-Type': 'application/json',
})

// ── MODEL COST CATALOG ──────────────────────────────────────────────────────
// `cents_per_sec` = real $ cost we pay HeyGen (rough, for cost display)
// `video_units_per_sec` = how much we charge against the user's video_units pool.
// 1 video unit ≈ 30 seconds of V3 standard render.
//
// Tweak these whenever HeyGen pricing or our credit ratio changes — the UI
// reads them at runtime through /api/avatars/models.
export const MODELS = {
  v3: {
    label:               'V3 — Standard',
    description:         'HeyGen Talking Photo. Solid lip-sync, fastest renders.',
    cents_per_sec:       8,
    video_units_per_sec: 0.10,    // 30s = 3 units
    badge:               'Fast',
  },
  v4: {
    label:               'V4 — Pro',
    description:         'Improved expressions and head motion. The everyday default.',
    cents_per_sec:       12,
    video_units_per_sec: 0.15,    // 30s = 4.5 units
    badge:               'Recommended',
  },
  v5: {
    label:               'V5 — Cinematic',
    description:         'Highest fidelity. Use it for hero ads and launch videos.',
    cents_per_sec:       18,
    video_units_per_sec: 0.20,    // 30s = 6 units
    badge:               'Premium',
  },
}

export function videoUnitsForModel(modelKey, durationSecs) {
  const m = MODELS[modelKey] || MODELS.v4
  return Math.max(1, Math.ceil((Number(durationSecs) || 0) * m.video_units_per_sec))
}

// ── Generic call helper ─────────────────────────────────────────────────────
async function call(method, url, body, opts = {}) {
  const resp = await fetch(url, {
    method,
    headers: opts.multipart ? { 'X-Api-Key': key() } : HEADERS(),
    body: opts.multipart ? body : (body ? JSON.stringify(body) : undefined),
  })
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`heygen ${resp.status}: ${data?.error?.message || data?.message || text}`)
    err.status = resp.status
    err.data = data
    throw err
  }
  return data
}

// ── Endpoints ───────────────────────────────────────────────────────────────

// List the user's HeyGen avatar groups
export const listAvatarGroups = (includePublic = false) =>
  call('GET', `${BASE_V2}/avatar_group.list?include_public=${includePublic ? 'true' : 'false'}`)

// List looks (camera angles + outfits) inside a group
export const listLooksForGroup = (groupId) =>
  call('GET', `${BASE_V2}/avatar_group/${groupId}/avatars`)

// HeyGen Photo Avatar — takes an image URL (or AI-generated prompt) and
// returns a talking_photo_id usable for instant avatar video generation.
//
// API: POST /v2/photo_avatar/photo/generate
// We use the URL flow (image already in our Storage bucket) — simpler than
// uploading binary directly.
export const createPhotoAvatarFromUrl = ({ imageUrl, name }) =>
  call('POST', `${BASE_V2}/photo_avatar/photo/generate`, {
    name: name || 'ScaleSolo avatar',
    age: 'Young Adult',
    gender: 'Unspecified',
    ethnicity: 'Unspecified',
    orientation: 'horizontal',
    pose: 'half_body',
    style: 'Realistic',
    appearance: imageUrl,    // The URL of the user-uploaded photo
  })

// Alternative: upload a photo file directly to HeyGen
// (kept for future use if the storage URL flow is unreliable)
export async function uploadPhotoBinary(buffer, contentType = 'image/jpeg') {
  const resp = await fetch(`${UPLOAD_BASE}/v1/asset`, {
    method: 'POST',
    headers: { 'Content-Type': contentType, 'X-Api-Key': key() },
    body: buffer,
  })
  const text = await resp.text()
  let data = null
  try { data = text ? JSON.parse(text) : null } catch { data = text }
  if (!resp.ok) {
    const err = new Error(`heygen upload ${resp.status}: ${typeof data === 'string' ? data : JSON.stringify(data)}`)
    err.status = resp.status
    throw err
  }
  return data    // { code, data: { url, image_key, ... } }
}

// Generate a video from a talking_photo_id + voice + script.
//   modelKey is informational on our side; HeyGen routes by avatar_id.
//   For v5 we can ask HeyGen for the higher-quality template.
export const generateVideo = ({ talkingPhotoId, avatarId, voiceId, script, dimension = { width: 1080, height: 1920 } }) =>
  call('POST', `${BASE_V2}/video/generate`, {
    video_inputs: [{
      character: talkingPhotoId
        ? { type: 'talking_photo', talking_photo_id: talkingPhotoId, scale: 1.0 }
        : { type: 'avatar', avatar_id: avatarId, avatar_style: 'normal' },
      voice: { type: 'text', input_text: script, voice_id: voiceId },
    }],
    dimension,
    test: false,
    callback_id: `scalesolo-${Date.now()}`,
  })

// Poll a video render status
export const getVideoStatus = (videoId) =>
  call('GET', `${BASE_V1}/video_status.get?video_id=${encodeURIComponent(videoId)}`)
