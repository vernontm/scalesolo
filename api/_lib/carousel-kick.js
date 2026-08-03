// Fire a background invocation of the carousel processor for one job. The
// call impersonates the job's user (internal secret + user id) so image
// generation bills the right ScaleSolo account. Best-effort: failures are
// swallowed because the every-minute cron re-kicks any unfinished job.

function baseUrl() {
  const raw = process.env.SITE_URL
    ? process.env.SITE_URL.replace(/\/$/, '')
    : (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : 'https://www.scalesolo.ai')
  // The apex 307-redirects to www, and the redirect hop loses the internal
  // auth POST — pin the canonical host so the kick lands directly.
  return raw === 'https://scalesolo.ai' ? 'https://www.scalesolo.ai' : raw
}

export async function kickCarouselJob(jobId, userId) {
  const secret = process.env.WORKFLOW_INTERNAL_SECRET
  if (!secret) return false
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), 6000)
    // /process acknowledges immediately (202) and does the work in the
    // background (waitUntil), so this resolves fast.
    await fetch(`${baseUrl()}/api/carousels/process`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-internal-secret': secret, 'x-impersonate-user': String(userId) },
      body: JSON.stringify({ job_id: jobId }),
      signal: ctrl.signal,
    }).catch(() => {})
    clearTimeout(t)
    return true
  } catch { return false }
}
