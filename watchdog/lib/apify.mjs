// Scrape the LIVE caption of a single published post via Apify.
//
// We call each platform's scraper with `run-sync-get-dataset-items`, which
// runs the actor and returns the dataset rows in one HTTP call. Actor slugs
// and their input/output field names occasionally change on Apify; they are
// isolated here so a first-run tweak is a one-file edit.
//
// Returns:
//   { found: true,  caption, hashtags }  post was scraped
//   { found: false, reason }             not indexed yet / no items (RETRY)
//   { found: false, reason, hardError }  actor/auth error (do not spin forever)

const ACTORS = {
  tiktok: {
    slug: 'clockworks~tiktok-video-scraper',
    input: (url) => ({ postURLs: [url], shouldDownloadVideos: false, resultsPerPage: 1 }),
    pick: (it) => ({
      caption: it.text ?? it.description ?? it.desc ?? '',
      hashtags: (it.hashtags || []).map((h) => h?.name || h).filter(Boolean),
    }),
  },
  instagram: {
    slug: 'apify~instagram-scraper',
    input: (url) => ({ directUrls: [url], resultsType: 'posts', resultsLimit: 1, addParentData: false }),
    pick: (it) => ({
      caption: it.caption ?? it.text ?? '',
      hashtags: it.hashtags || [],
    }),
  },
  youtube: {
    slug: 'streamers~youtube-scraper',
    input: (url) => ({ startUrls: [{ url }], maxResults: 1, maxResultsShorts: 1 }),
    pick: (it) => ({
      // YouTube "caption" is the video description; title is a useful fallback.
      caption: it.text ?? it.description ?? it.title ?? '',
      hashtags: it.hashtags || [],
    }),
  },
}

// Map a live URL to one of our supported platforms.
export function platformFromUrl(url = '') {
  const u = String(url).toLowerCase()
  if (u.includes('tiktok.com')) return 'tiktok'
  if (u.includes('instagram.com')) return 'instagram'
  if (u.includes('youtube.com') || u.includes('youtu.be')) return 'youtube'
  return null
}

export async function scrapeLivePost({ url, platform, token, timeoutMs = 120000 }) {
  const cfg = ACTORS[platform]
  if (!cfg) return { found: false, reason: `unsupported platform: ${platform}`, hardError: true }
  if (!token) return { found: false, reason: 'APIFY_TOKEN missing', hardError: true }

  const endpoint = `https://api.apify.com/v2/acts/${cfg.slug}/run-sync-get-dataset-items?token=${encodeURIComponent(token)}`
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), timeoutMs)
  let res
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(cfg.input(url)),
      signal: ctrl.signal,
    })
  } catch (e) {
    clearTimeout(timer)
    // Network / timeout: treat as transient so we retry, not a hard error.
    return { found: false, reason: `apify request failed: ${e?.message || e}` }
  }
  clearTimeout(timer)

  if (res.status === 401 || res.status === 403) {
    return { found: false, reason: `apify auth failed (${res.status})`, hardError: true }
  }
  if (!res.ok) {
    return { found: false, reason: `apify http ${res.status}` }
  }

  let items
  try {
    items = await res.json()
  } catch {
    return { found: false, reason: 'apify returned non-JSON' }
  }
  if (!Array.isArray(items) || items.length === 0) {
    // No dataset rows: the post almost certainly is not indexed yet. RETRY.
    return { found: false, reason: 'post not indexed yet (no scrape result)' }
  }

  const { caption, hashtags } = cfg.pick(items[0])
  return { found: true, caption: String(caption || ''), hashtags: hashtags || [] }
}
