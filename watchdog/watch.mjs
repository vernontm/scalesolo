#!/usr/bin/env node
// ScaleSolo post-caption watchdog (runs on Ray's Mac).
//
// One shot per invocation (schedule it with launchd every ~60s):
//   1. Read new `post.published` notifications from Supabase.
//   2. Scrape each live post's real caption via Apify (TikTok/IG/YouTube).
//   3. If the caption is empty / a junk tag / has no hashtags, iMessage
//      the alert number with "URGENT: ...".
//   4. Posts not indexed yet are retried on later runs, never false-alarmed.
//
// Usage:
//   node watch.mjs                 run one cycle
//   node watch.mjs --dry-run       do everything but print alerts instead of texting
//   node watch.mjs --test-message  send one test iMessage and exit
//   node watch.mjs --check "text"  evaluate a caption string and exit (no network)

import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { existsSync, statSync, writeFileSync, rmSync } from 'node:fs'
import { loadEnv, getConfig, loadState, saveState } from './lib/config.mjs'
import { fetchNewPublished, brandName } from './lib/supabase.mjs'
import { scrapeLivePost, platformFromUrl } from './lib/apify.mjs'
import { evaluateCaption } from './lib/caption.mjs'
import { sendIMessage } from './lib/imessage.mjs'

const DIR = dirname(fileURLToPath(import.meta.url))
loadEnv(join(DIR, '.env'))
const cfg = getConfig()
const STATE_PATH = join(DIR, 'state.json')
const LOCK_PATH = join(DIR, '.lock')
const log = (...a) => console.log(new Date().toISOString(), ...a)

// ── one-off modes ────────────────────────────────────────────────────────
if (process.argv.includes('--check')) {
  const text = process.argv[process.argv.indexOf('--check') + 1] || ''
  console.log(JSON.stringify(evaluateCaption({ caption: text, requireHashtags: cfg.requireHashtags }), null, 2))
  process.exit(0)
}
if (process.argv.includes('--test-message')) {
  if (!cfg.alertTo) { console.error('ALERT_IMESSAGE_TO not set'); process.exit(1) }
  await sendIMessage({ to: cfg.alertTo, text: 'ScaleSolo watchdog test message. If you got this, alerts work.', dryRun: cfg.dryRun })
  log('test message sent to', cfg.alertTo)
  process.exit(0)
}

// ── config sanity ────────────────────────────────────────────────────────
for (const [k, v] of Object.entries({ SUPABASE_URL: cfg.supabaseUrl, SUPABASE_SERVICE_KEY: cfg.supabaseKey, APIFY_TOKEN: cfg.apifyToken, ALERT_IMESSAGE_TO: cfg.alertTo })) {
  if (!v) { console.error(`Missing required config: ${k} (see watchdog/.env.example)`); process.exit(1) }
}

// ── overlap lock (a cycle with retries can outlast the 60s interval) ──────
if (existsSync(LOCK_PATH)) {
  const ageMs = Date.now() - statSync(LOCK_PATH).mtimeMs
  if (ageMs < 5 * 60 * 1000) { log('another run is active; exiting'); process.exit(0) }
}
writeFileSync(LOCK_PATH, String(process.pid))

async function alert({ brand, platform, url, reasons }) {
  const text = `URGENT: ${brand} ${platform} post has a caption problem: ${reasons.join('; ')}. ${url}`
  await sendIMessage({ to: cfg.alertTo, text, dryRun: cfg.dryRun })
  log(cfg.dryRun ? '[dry-run] would alert:' : 'ALERTED:', text)
}

async function main() {
  const state = loadState(STATE_PATH)
  const processed = new Set(state.processed || [])
  const nowMs = Date.now()
  const sinceIso = state.lastSeenIso
    || new Date(nowMs - cfg.firstRunLookbackMin * 60 * 1000).toISOString()

  // 1. Pull new published posts and turn them into work items.
  let fresh = []
  try {
    fresh = await fetchNewPublished({ url: cfg.supabaseUrl, key: cfg.supabaseKey, sinceIso })
  } catch (e) {
    log('supabase read failed:', e.message)
    rmSync(LOCK_PATH, { force: true })
    process.exit(1)
  }

  let lastSeenIso = state.lastSeenIso
  const pending = Array.isArray(state.pending) ? state.pending : []
  for (const n of fresh) {
    if (!lastSeenIso || n.created_at > lastSeenIso) lastSeenIso = n.created_at
    if (processed.has(n.id)) continue
    const url = n?.meta?.post_url || null
    const platform = url ? platformFromUrl(url) : null
    if (!url || !platform || !cfg.platforms.includes(platform)) {
      // Nothing scrapeable (text post, inbox-only, or platform not covered).
      processed.add(n.id)
      continue
    }
    if (!pending.some((p) => p.notifId === n.id)) {
      pending.push({ notifId: n.id, url, platform, profileId: n.profile_id, firstSeenMs: nowMs, attempts: 0 })
    }
  }

  // 2+3. Work the pending queue (new + carried-over retries).
  const stillPending = []
  for (const item of pending) {
    if (processed.has(item.notifId)) continue
    let r
    try {
      r = await scrapeLivePost({ url: item.url, platform: item.platform, token: cfg.apifyToken })
    } catch (e) {
      r = { found: false, reason: `scrape threw: ${e?.message || e}` }
    }
    item.attempts = (item.attempts || 0) + 1

    if (r.hardError) {
      log('hard error, dropping', item.url, '-', r.reason)
      processed.add(item.notifId)
      continue
    }
    if (!r.found) {
      const ageMin = (nowMs - item.firstSeenMs) / 60000
      if (ageMin < cfg.retryWindowMin) {
        stillPending.push(item) // try again next cycle
      } else {
        log('gave up (never scrapeable) after', Math.round(ageMin), 'min:', item.url)
        processed.add(item.notifId)
      }
      continue
    }

    const verdict = evaluateCaption({
      caption: r.caption, hashtags: r.hashtags, platform: item.platform, requireHashtags: cfg.requireHashtags,
    })
    if (!verdict.ok) {
      const brand = await brandName({ url: cfg.supabaseUrl, key: cfg.supabaseKey, profileId: item.profileId })
      await alert({ brand, platform: item.platform, url: item.url, reasons: verdict.reasons })
    } else {
      log('ok:', item.platform, item.url)
    }
    processed.add(item.notifId)
  }

  state.lastSeenIso = lastSeenIso
  state.processed = [...processed]
  state.pending = stillPending
  saveState(STATE_PATH, state)
  log(`cycle done. new=${fresh.length} pending=${stillPending.length}`)
}

try {
  await main()
} catch (e) {
  log('fatal:', e?.stack || e)
} finally {
  rmSync(LOCK_PATH, { force: true })
}
