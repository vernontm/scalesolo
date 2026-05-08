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

export async function notify({ user_id, profile_id = null, kind, level = 'info', title, body = null, href = null, meta = null }) {
  if (!user_id || !kind || !title) {
    console.warn('notify() called with missing required field; skipping', { user_id, kind, title })
    return null
  }
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
