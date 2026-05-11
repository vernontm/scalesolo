// Server-side helper for emitting in-app notifications.
//
// Usage from any Vercel function or worker:
//   import { notify } from '../_lib/notify.js'
//   await notify({
//     user_id, profile_id,
//     kind:  'render.done',
//     level: 'success',
//     title: 'Avatar render finished',
//     body:  'Your video is ready in the canvas.',
//     href:  `/spaces/${spaceId}`,
//     meta:  { space_id: spaceId, video_url, run_id },
//   })
//
// Inserts via the service-role key so it ignores RLS, and triggers the
// `supabase_realtime` publication — the SPA receives the row over its
// open Realtime channel and the bell updates instantly.
//
// All fields except user_id, kind, title are optional. Failures never
// throw — notifications are best-effort signaling, not transactional.

import { supaFetch } from './supabase.js'

const ALLOWED_LEVELS = new Set(['info', 'success', 'warning', 'error'])

// Maps notification kinds → the key in user_profiles.notification_prefs
// that gates whether this notification should fire. Keys not in this map
// are always allowed (system / billing notifications the user can't opt
// out of). Add a new entry whenever you ship a new pref toggle.
const KIND_PREF_KEY = {
  'run.done':           'run_done',
  'render.done':        'run_done',
  'render.failed':      'run_done',
  'post.scheduled':     'post_scheduled',
  'post.published':     'post_published',
  'post.failed':        'post_failed',
  'credits.low':        'credits_low',
  // Server-side auto-run lifecycle. The worker emits these directly
  // (writes to the notifications table via service-role) so they
  // bypass the Vercel /api/_lib/notify path — listed here for the
  // user-prefs mute toggle, not for the notify() helper itself.
  'workflow.started':   'workflow_run',
  'workflow.done':      'workflow_run',
  'workflow.failed':    'workflow_run',
}

async function isKindAllowed(user_id, kind) {
  const key = KIND_PREF_KEY[kind]
  if (!key) return true   // not gated
  try {
    const rows = await supaFetch(`user_profiles?id=eq.${user_id}&select=notification_prefs`)
    const prefs = rows?.[0]?.notification_prefs || {}
    // Default-on: missing key = enabled.
    return prefs[key] !== false
  } catch {
    return true  // fail open so users still get critical signals
  }
}

export async function notify({ user_id, profile_id = null, kind, level = 'info', title, body = null, href = null, meta = null }) {
  if (!user_id || !kind || !title) {
    console.warn('notify() called with missing required field; skipping', { user_id, kind, title })
    return null
  }
  // Honor per-user notification preferences. Errors / billing-critical
  // events bypass the pref check via KIND_PREF_KEY whitelist.
  if (!(await isKindAllowed(user_id, kind))) return null
  const safeLevel = ALLOWED_LEVELS.has(level) ? level : 'info'
  try {
    const rows = await supaFetch('notifications', {
      method: 'POST',
      body: JSON.stringify([{
        user_id, profile_id,
        kind, level: safeLevel,
        title: String(title).slice(0, 200),
        body: body ? String(body).slice(0, 2000) : null,
        href, meta,
      }]),
    })
    return Array.isArray(rows) ? rows[0] : rows
  } catch (e) {
    console.warn('notify() insert failed:', e.message)
    return null
  }
}

// Convenience emitters with sensible defaults so callers don't repeat
// title/level for the common cases.
export const NotifyKind = {
  renderDone: ({ user_id, profile_id, space_id, video_url }) => notify({
    user_id, profile_id,
    kind: 'render.done', level: 'success',
    title: 'Avatar render finished',
    body:  'Your video is ready.',
    href:  space_id ? `/spaces?id=${space_id}` : '/spaces',
    meta:  { space_id, video_url },
  }),
  renderFailed: ({ user_id, profile_id, space_id, error }) => notify({
    user_id, profile_id,
    kind: 'render.failed', level: 'error',
    title: 'Avatar render failed',
    body:  error || 'See the canvas for details.',
    href:  space_id ? `/spaces?id=${space_id}` : '/spaces',
    meta:  { space_id, error },
  }),
  postPublished: ({ user_id, profile_id, platforms = [], post_url = null }) => notify({
    user_id, profile_id,
    kind: 'post.published', level: 'success',
    title: `Posted to ${platforms.length === 1 ? platforms[0] : `${platforms.length} platforms`}`,
    body:  post_url || null,
    href:  '/content',
    meta:  { platforms, post_url },
  }),
  postScheduled: ({ user_id, profile_id, platforms = [], scheduled_for = null, title = null }) => notify({
    user_id, profile_id,
    kind: 'post.scheduled', level: 'info',
    title: `Scheduled${title ? `: ${title}` : ''}`,
    body:  scheduled_for ? `Goes live ${new Date(scheduled_for).toLocaleString()}` : null,
    href:  '/schedule',
    meta:  { platforms, scheduled_for },
  }),
  runDone: ({ user_id, profile_id, space_id, space_name = null }) => notify({
    user_id, profile_id,
    kind: 'run.done', level: 'success',
    title: space_name ? `Run finished: ${space_name}` : 'Run finished',
    body:  'Your space finished executing.',
    href:  space_id ? `/spaces?id=${space_id}` : '/spaces',
    meta:  { space_id },
  }),
  postFailed: ({ user_id, profile_id, error }) => notify({
    user_id, profile_id,
    kind: 'post.failed', level: 'error',
    title: 'Scheduled post failed',
    body:  error || 'Open the post to retry.',
    href:  '/content',
    meta:  { error },
  }),
  creditsLow: ({ user_id, pool, balance }) => notify({
    user_id,
    kind: 'credits.low', level: 'warning',
    title: 'Credits running low',
    body:  `Only ${balance} ${pool} left. Top up to keep automations running.`,
    href:  '/billing',
    meta:  { pool, balance },
  }),
  autoRunTickFailed: ({ user_id, profile_id, space_id, error }) => notify({
    user_id, profile_id,
    kind: 'autorun.tick_failed', level: 'warning',
    title: 'Auto-run tick failed',
    body:  error || 'A scheduled tick errored. The cycle continues on the next cadence.',
    href:  space_id ? `/spaces?id=${space_id}` : '/spaces',
    meta:  { space_id, error },
  }),
}
