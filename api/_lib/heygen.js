// HeyGen REST wrapper — split between two API generations:
//   /v2/video/generate     → Avatar III (legacy talking-photo). Used for our V3 tier.
//   /v3/videos             → Avatar IV / Avatar V. Used for our V4 + V5 tiers.
//
// HeyGen's /v3/videos has no explicit model_version field — the server
// auto-routes to Avatar IV today and the upcoming Avatar V when it's enabled.
// Our V5 tier passes `expressiveness: high` + a motion_prompt to push the
// engine toward its highest-fidelity output.

const BASE_V2 = 'https://api.heygen.com/v2'
const BASE_V3 = 'https://api.heygen.com/v3'
const BASE_V1 = 'https://api.heygen.com/v1'

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
// `engine` maps our label → which API path the render dispatches to.
// `cents_per_sec`     = real $ cost we pay HeyGen (Photo Avatar 1080p tier
//                       per their dev pricing page, Nov 2025). Used for
//                       COGS display in the admin usage dashboard.
// `cents_per_sec_4k`  = same but the 4K tier — bumped ~25% on V4/V5 and
//                       ~20% on V3.
// `video_units_per_sec` = how much we charge against the user's video_units
//                       pool. Wholesale-ish; one video_unit ≈ a 6-7s clip.
//
// Sources:
//   https://developers.heygen.com/docs/pricing#video-generation-%E2%80%94-avatar-iv
// Update this in one place — UI reads it through /api/avatars at runtime.
// V4 is the only supported model going forward. V3 (cheaper, lower
// quality) and V5 (more expensive, marginally better motion) were
// retired to simplify the UI and pricing math — one rate to the
// user, one rate from HeyGen. Old saved spaces that reference
// model: 'v3' or 'v5' silently fall through to v4 via the lookup
// helpers below.
export const MODELS = {
  v4: {
    label:               'Avatar Video',
    description:         'The default talking-photo renderer.',
    engine:              'v3_avatar_iv',
    expressiveness:      'low',
    cents_per_sec:       5,       // HeyGen Avatar IV Photo 720/1080p
    cents_per_sec_4k:    6.67,
    video_units_per_sec: 0.15,
    badge:               'Recommended',
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

// ── Avatar / Photo Avatar management ────────────────────────────────────────
export const listAvatarGroups = (includePublic = false) =>
  call('GET', `${BASE_V2}/avatar_group.list?include_public=${includePublic ? 'true' : 'false'}`)

export const listLooksForGroup = (groupId) =>
  call('GET', `${BASE_V2}/avatar_group/${groupId}/avatars`)

// HeyGen Photo Avatar (legacy V2). Async — returns generation_id, not a
// renderable avatar id. Kept for back-compat; new flows use V3 below.
export const createPhotoAvatarFromUrl = ({ imageUrl, name }) =>
  call('POST', `${BASE_V2}/photo_avatar/photo/generate`, {
    name: name || 'ScaleSolo avatar',
    age: 'Young Adult',
    gender: 'Unspecified',
    ethnicity: 'Unspecified',
    orientation: 'horizontal',
    pose: 'half_body',
    style: 'Realistic',
    appearance: imageUrl,
  })

// HeyGen V3 Photo Avatar — synchronous, returns a renderable avatar_id
// (data.avatar_item.id) ready to use with /v3/videos immediately.
// Per https://developers.heygen.com/image-to-video#from-url
export const createPhotoAvatarV3 = ({ imageUrl, name }) =>
  call('POST', `${BASE_V3}/avatars`, {
    type: 'photo',
    name: name || `ScaleSolo photo ${Date.now()}`,
    file: { type: 'url', url: imageUrl },
  })

export const getVideoStatusV3Direct = (videoId) =>
  call('GET', `${BASE_V3}/videos/${videoId}`)

// ── Render: V2 legacy (Avatar III, our V3 tier) ─────────────────────────────
export const generateVideoV2 = ({ talkingPhotoId, voiceId, script, audioUrl, dimension = { width: 1080, height: 1920 } }) =>
  call('POST', `${BASE_V2}/video/generate`, {
    video_inputs: [{
      character: { type: 'talking_photo', talking_photo_id: talkingPhotoId, scale: 1.0 },
      voice: audioUrl
        ? { type: 'audio', audio_url: audioUrl }
        : { type: 'text', input_text: script, voice_id: voiceId },
    }],
    dimension,
    test: false,
    callback_id: `scalesolo-${Date.now()}`,
  })

// ── Render: V3 (Avatar IV today, Avatar V on rollout — our V4 + V5 tiers) ──
//   modelKey controls expressiveness + motion. Same endpoint either way.
export const generateVideoV3 = ({ avatarId, voiceId, script, audioUrl, modelKey = 'v4', extras = {} }) => {
  const m = MODELS[modelKey] || MODELS.v4
  const body = {
    type: 'avatar',
    avatar_id: avatarId,
    title: extras.title || `ScaleSolo ${modelKey.toUpperCase()} render`,
    resolution: extras.resolution || '1080p',
    aspect_ratio: extras.aspect_ratio || '9:16',
    expressiveness: m.expressiveness || 'low',
  }
  if (audioUrl) {
    // Lip-sync to a user-provided audio file; bypass HeyGen's TTS.
    // HeyGen V3 expects audio_url at the ROOT of the body (alongside
    // script/voice_id/audio_asset_id) — not inside a "voice" sub-object.
    // Putting it in body.voice triggers "Value error, An audio source
    // is required" because the validator only checks the root.
    body.audio_url = audioUrl
  } else {
    body.script = script
    body.voice_id = voiceId
  }
  if (m.motion_default && extras.motion_prompt !== '' && script) {
    body.motion_prompt = extras.motion_prompt || deriveMotionPromptFromScript(script)
  }
  if (extras.callback_url) body.callback_url = extras.callback_url
  return call('POST', `${BASE_V3}/videos`, body)
}

// Naive: take the first sentence of the script as a coarse motion hint.
function deriveMotionPromptFromScript(script) {
  const first = (script || '').split(/[.!?]/)[0]?.trim().slice(0, 160) || ''
  return first ? `Subject naturally delivering: "${first}"` : 'Confident on-camera delivery'
}

// ── Status polling ──────────────────────────────────────────────────────────
export const getVideoStatusV2 = (videoId) =>
  call('GET', `${BASE_V1}/video_status.get?video_id=${encodeURIComponent(videoId)}`)

export const getVideoStatusV3 = (videoId) =>
  call('GET', `${BASE_V3}/videos/${encodeURIComponent(videoId)}`)

// Convenience: dispatches to the right poll based on which engine produced the render.
export const getVideoStatusForEngine = (videoId, engine) => {
  if (engine === 'v3_avatar_iv' || engine === 'v3_avatar_v') return getVideoStatusV3(videoId)
  return getVideoStatusV2(videoId)
}
