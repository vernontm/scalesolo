// Thin client around the ZapCap caption-rendering API.
// Docs: https://platform.zapcap.ai/docs
//
// Auth: x-api-key header. Set ZAPCAP_API_KEY in Vercel env.
//
// Render flow we use:
//   1. POST /videos/url    {url}          → { id }                add video by URL
//   2. POST /videos/{id}/task {templateId, autoApprove:true} → { taskId }
//   3. GET  /videos/{id}/task/{taskId}    → { status, downloadUrl? }
//      Statuses: pending → transcribing → transcriptionCompleted →
//                rendering → completed | failed

const BASE = 'https://api.zapcap.ai'

function key() {
  const k = process.env.ZAPCAP_API_KEY
  if (!k) throw new Error('ZAPCAP_API_KEY not configured')
  return k
}

export async function zapcap(path, { method = 'GET', body, headers = {} } = {}) {
  const init = {
    method,
    headers: { 'x-api-key': key(), Accept: 'application/json', ...headers },
  }
  if (body !== undefined) {
    init.body = typeof body === 'string' ? body : JSON.stringify(body)
    if (!init.headers['Content-Type']) init.headers['Content-Type'] = 'application/json'
  }
  const r = await fetch(`${BASE}${path}`, init)
  const txt = await r.text()
  let data = null
  try { data = txt ? JSON.parse(txt) : {} } catch { data = { raw: txt } }
  if (!r.ok) {
    const msg = data?.message || data?.error || `ZapCap ${path} → ${r.status}`
    const err = new Error(typeof msg === 'string' ? msg : JSON.stringify(msg))
    err.status = r.status
    err.response = data
    throw err
  }
  return data
}

export async function zapcapListTemplates() {
  return zapcap('/templates', { method: 'GET' })
}

export async function zapcapAddVideoByUrl(url, { ttl = '1d' } = {}) {
  const data = await zapcap(`/videos/url${ttl ? `?ttl=${encodeURIComponent(ttl)}` : ''}`, {
    method: 'POST', body: { url },
  })
  return data.id || data.videoId
}

export async function zapcapCreateTask(videoId, { templateId, language = 'en', autoApprove = true, renderOptions } = {}) {
  if (!templateId) throw new Error('zapcap: templateId required')
  const data = await zapcap(`/videos/${videoId}/task`, {
    method: 'POST',
    body: { templateId, language, autoApprove, ...(renderOptions ? { renderOptions } : {}) },
  })
  return data.id || data.taskId
}

export async function zapcapPollTask(videoId, taskId, { timeoutMs = 6 * 60 * 1000, intervalMs = 4000, shouldAbort } = {}) {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (shouldAbort?.()) throw new Error('Aborted')
    const data = await zapcap(`/videos/${videoId}/task/${taskId}`, { method: 'GET' })
    if (data.status === 'completed') return data
    if (data.status === 'failed') {
      throw new Error(data.error || data.message || 'ZapCap render failed')
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error('ZapCap render timed out')
}
