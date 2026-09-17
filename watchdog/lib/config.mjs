// Tiny zero-dependency .env loader + JSON state persistence.

import { readFileSync, writeFileSync, existsSync } from 'node:fs'

// Parse a .env file and set any keys not already in process.env.
export function loadEnv(path) {
  if (!existsSync(path)) return
  const txt = readFileSync(path, 'utf8')
  for (const line of txt.split('\n')) {
    const m = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i)
    if (!m) continue
    let val = m[2]
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val
  }
}

export function getConfig() {
  const platforms = (process.env.PLATFORMS || 'tiktok,instagram,youtube')
    .split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)
  return {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseKey: process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY || '',
    apifyToken: process.env.APIFY_TOKEN || '',
    alertTo: process.env.ALERT_IMESSAGE_TO || '',
    platforms,
    requireHashtags: (process.env.REQUIRE_HASHTAGS || 'true') !== 'false',
    // How long to keep retrying a post that is not indexed yet (minutes).
    retryWindowMin: Number(process.env.RETRY_WINDOW_MIN || 25),
    // On the very first run, look back this many minutes for published posts.
    firstRunLookbackMin: Number(process.env.FIRST_RUN_LOOKBACK_MIN || 15),
    dryRun: process.env.DRY_RUN === '1' || process.argv.includes('--dry-run'),
  }
}

export function loadState(path) {
  if (!existsSync(path)) return { lastSeenIso: null, processed: [], pending: [] }
  try { return JSON.parse(readFileSync(path, 'utf8')) }
  catch { return { lastSeenIso: null, processed: [], pending: [] } }
}

export function saveState(path, state) {
  // Keep the processed-id list bounded so state.json never grows unbounded.
  if (Array.isArray(state.processed) && state.processed.length > 500) {
    state.processed = state.processed.slice(-500)
  }
  writeFileSync(path, JSON.stringify(state, null, 2))
}
