// POST /api/social/upload-post
// Body: {
//   profile_id, upload_post_user, platforms: ['tiktok', ...],
//   video_url? | photo_urls?,
//   description?, title?,
//   scheduled_iso?, timezone?,
// }
// Returns: { request_id, raw }
//
// Thin proxy to https://api.upload-post.com/api with the service-side
// API key. The Upload-Post account (= the per-user token they configure
// inside the Upload-Post dashboard) is identified by `upload_post_user`,
// which lets one ScaleSolo account post to many social handles.
//
// We download the video / photos here and forward as multipart/form-data
// because Upload-Post wants the bytes, not a URL.

import { setCors, requireUser, supaFetch, assertProfileAccess } from '../_lib/supabase.js'
import { resolveUploadpostUser, uploadpostEnsureUserProfile } from '../_lib/uploadpost.js'
import { isUserOnTrial } from '../_lib/billing.js'
import { findNextOpenSlot } from '../_lib/scheduling.js'
import { NotifyKind } from '../_lib/notify.js'

// 300s (was 60s). Even with async_upload=true, Upload-Post sometimes
// needs 60-120s to ack on first ingest of a video URL — their server
// fetches the file from our public bucket before returning the
// request_id. A 17-clip schedule_post batch hit 5 timeouts at the 60s
// cap. 300s gives plenty of headroom; if a real network issue happens
// the function still bails before sitting forever.
export const config = { maxDuration: 300 }

async function fetchToBlob(url) {
  const r = await fetch(url)
  if (!r.ok) throw new Error(`Fetch ${url} → ${r.status}`)
  const ab = await r.arrayBuffer()
  return new Blob([ab])
}

function ext(url, fallback) {
  try { return (new URL(url).pathname.split('.').pop() || fallback).toLowerCase() }
  catch { return fallback }
}

export default async function handler(req, res) {
  setCors(req, res)
  if (req.method === 'OPTIONS') return res.status(204).end()

  const auth = await requireUser(req, res)
  if (!auth) return

  // GET /api/social/upload-post?action=status&request_id=...
  if (req.method === 'GET') {
    const apiKey = process.env.UPLOADPOST_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })
    const requestId = req.query.request_id
    if (!requestId) return res.status(400).json({ error: 'request_id required' })
    const r = await fetch(`https://api.upload-post.com/api/uploadposts/status?request_id=${encodeURIComponent(requestId)}`, {
      headers: { Authorization: `Apikey ${apiKey}` },
    })
    const body = await r.json().catch(() => ({}))
    return res.status(r.ok ? 200 : 502).json(body)
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' })

  try {
    const {
      profile_id, upload_post_user, platforms,
      video_url, photo_urls,
      description, title,
      scheduling_mode,        // 'now' | 'fixed' | 'auto'
      scheduled_iso, timezone,
      // Distinct copy fields from schedule_post node, so persistence
      // can put each in its own content_scripts column instead of
      // shoving the merged description into full_script. All optional;
      // we fall back to splitting `description` if these aren't sent.
      caption: rawCaption,
      hashtags: rawHashtags,
      script: rawScript,
      first_comment: rawFirstComment,
      // Text-only post bundle from text_post_gen. When is_text_post is
      // true, no media is required and per_platform_text holds the
      // platform-specific variants. We persist the variants on the
      // row and use the first variant as the canonical description.
      is_text_post,
      per_platform_text,
      // Optional per-post Instagram cover (generated via /api/content/
      // generate-cover from the brand's cover_template). When set + IG
      // is in platforms, we pass it as instagram_cover_url so the Reel
      // posts with a custom thumbnail. Other platforms ignore it.
      cover_image_url,
    } = req.body || {}

    if (!profile_id || !Array.isArray(platforms) || !platforms.length) {
      return res.status(400).json({ error: 'profile_id, platforms required' })
    }
    // Trial users can generate + preview, but they can't publish.
    // We return the same 402 shape the credit wall uses so the
    // canvas's existing OutOfCreditsModal handler pops the upgrade
    // CTA. The error message tells the user exactly why.
    if (await isUserOnTrial(auth.user.id)) {
      return res.status(402).json({
        error: 'Publishing to social accounts is locked during the free trial. Upgrade to start scheduling posts.',
        code: 'trial_publish_blocked',
      })
    }
    const isVideo = !!video_url
    const photos = Array.isArray(photo_urls) ? photo_urls.filter(Boolean) : []
    const isText = !!is_text_post
    if (!isVideo && !photos.length && !isText) {
      return res.status(400).json({ error: 'video_url, photo_urls, or is_text_post required' })
    }
    await assertProfileAccess(auth.user.id, profile_id)

    const apiKey = process.env.UPLOADPOST_API_KEY
    if (!apiKey) return res.status(500).json({ error: 'UPLOADPOST_API_KEY not configured' })

    // Derive a stable per-profile sub-account username, auto-creating the
    // Upload-Post profile if it doesn't exist yet. Caller can still pass an
    // explicit upload_post_user to override (useful for shared accounts).
    const effectiveUser = upload_post_user || await resolveUploadpostUser(profile_id)
    if (!upload_post_user) {
      try { await uploadpostEnsureUserProfile(effectiveUser) } catch (e) {
        console.warn('upload-post ensure profile failed:', e.message)
      }
    }

    // Pre-flight credit check (cheap fee — Upload-Post itself is paid for
    // outside the app on their side, this is just a transaction marker).
    const cust = await supaFetch(`billing_customers?user_id=eq.${auth.user.id}&select=id`)
    const customerId = cust?.[0]?.id
    const fee = 100
    if (customerId) {
      const pools = await supaFetch(`credit_pools?customer_id=eq.${customerId}&pool_type=eq.ai_tokens&select=balance`)
      if ((Number(pools?.[0]?.balance ?? 0)) < fee) {
        return res.status(402).json({ error: 'Insufficient AI tokens.', code: 'insufficient_credits' })
      }
    }

    // Build the multipart payload Upload-Post expects. We map the
    // canonical title + description (caption + hashtags) + first_comment
    // to each platform's specific overrides with proper character-limit
    // handling. Per Upload-Post docs:
    //   • `description` is the catch-all caption used by LinkedIn, FB,
    //     YouTube, and Pinterest.
    //   • Each platform also exposes a `<platform>_title` override for
    //     its caption / post text, with platform-specific char limits.
    //   • `first_comment` is supported on IG, FB, X, Threads, YT, Reddit,
    //     Bluesky, LinkedIn — falls through to per-platform overrides.
    //
    // Char caps (verified against docs.upload-post.com):
    //   tiktok 2200 · instagram 2200 · facebook 63206 (no real limit)
    //   youtube_title 100 · youtube_description 5000
    //   linkedin 3000 · threads 500 · bluesky 300 · x auto-threads
    //   pinterest_title 100 · pinterest_description 800 · reddit_title 300
    const fullCaption = String(description || '').trim()    // caption + "\n\n" + hashtags
    const cleanTitle  = String(title || '').trim()
    const trim = (s, n) => (s || '').slice(0, n)

    const fd = new FormData()
    fd.append('user', effectiveUser)
    for (const p of platforms) fd.append('platform[]', p)
    if (fullCaption) fd.append('description', trim(fullCaption, 5000))
    // Upload-Post's /api/upload_text requires `title` and treats it as the
    // actual POST BODY (not a 100-char headline like the video / photo
    // endpoints do). Send the full caption there so long threads do not
    // get sliced to 100 chars; fall back to the regular title when no
    // caption is wired in.
    if (isText) {
      const textBody = fullCaption || cleanTitle
      if (textBody) fd.append('title', trim(textBody, 5000))
    } else if (cleanTitle) {
      fd.append('title', trim(cleanTitle, 100))
    }

    // Per-platform caption/title fan-out. Every selected platform gets
    // the SAME caption + hashtags via its <platform>_title field, trimmed
    // to that platform's limit. Platforms that also expose a separate
    // long-description field (YouTube, Facebook, LinkedIn, Pinterest)
    // get the full caption there too.
    if (platforms.includes('tiktok')) {
      // TikTok's "title" IS the caption.
      fd.append('tiktok_title', trim(fullCaption || cleanTitle, 2200))
    }
    if (platforms.includes('instagram')) {
      fd.append('instagram_title', trim(fullCaption || cleanTitle, 2200))
      // Custom Reel cover, if the user generated one for this post on
      // the Schedule page. Upload-Post accepts an absolute URL via
      // `instagram_cover_url` and fetches the bytes itself.
      if (cover_image_url) fd.append('instagram_cover_url', String(cover_image_url))
    }
    if (platforms.includes('facebook')) {
      // FB's "title" is post caption; "description" is the long body.
      // Title field has a hard 255-char limit (FB's API rejects past that —
      // saw "Facebook title is too long (767 characters)" in production).
      // Description has no real cap; we use the full caption there.
      //
      // We aim for 240 (not 255) because the upload-post.com layer
      // counts characters differently than JS slice when emojis,
      // newlines, or fancy unicode are involved — seen 259 reported
      // back even after slice(0, 255). Knock newlines down to single
      // spaces too so FB doesn't expand them into paragraph breaks
      // that bloat the count further on their end.
      const fbTitleSource = (fullCaption || cleanTitle || '').replace(/\s*\n+\s*/g, ' ').trim()
      fd.append('facebook_title', trim(fbTitleSource, 240))
      fd.append('facebook_description', trim(fullCaption || cleanTitle, 5000))
    }
    if (platforms.includes('youtube')) {
      fd.append('youtube_title', trim(cleanTitle, 100))
      fd.append('youtube_description', trim(fullCaption || cleanTitle, 5000))
    }
    if (platforms.includes('linkedin')) {
      fd.append('linkedin_title', trim(fullCaption || cleanTitle, 3000))
      fd.append('linkedin_description', trim(fullCaption || cleanTitle, 3000))
    }
    if (platforms.includes('threads')) {
      // Threads caps at 500. Trim hard — not auto-threaded by Upload-Post.
      fd.append('threads_title', trim(fullCaption || cleanTitle, 500))
    }
    if (platforms.includes('twitter') || platforms.includes('x')) {
      // Upload-Post auto-threads X posts that exceed 280 chars when
      // x_long_text_as_post is false (default). Send the full caption +
      // hashtags and let Upload-Post split.
      fd.append('x_title', trim(fullCaption || cleanTitle, 25000))
    }
    if (platforms.includes('pinterest')) {
      fd.append('pinterest_title', trim(cleanTitle || fullCaption, 100))
      fd.append('pinterest_description', trim(fullCaption || cleanTitle, 800))
    }
    if (platforms.includes('bluesky')) {
      // Bluesky caps at 300 characters. Hard trim.
      fd.append('bluesky_title', trim(fullCaption || cleanTitle, 300))
    }
    if (platforms.includes('reddit')) {
      fd.append('reddit_title', trim(cleanTitle || fullCaption, 300))
    }

    // First-comment fan-out. Upload-Post takes a top-level `first_comment`
    // that fans out to every platform that supports the feature; per-
    // platform overrides exist if we ever need them. Send once at the top.
    const firstCommentResolved = String(rawFirstComment || '').trim()
    if (firstCommentResolved) {
      // 1000 char ceiling is generous for any platform's reply field.
      fd.append('first_comment', trim(firstCommentResolved, 1000))
    }
    // Resolve "auto" mode: pull the brand profile's posting schedule + the
    // already-scheduled posts on it, find the next open slot. Done at submit
    // time (not at queue time) so the slot reflects what's actually free
    // when the run finishes.
    let resolvedScheduledIso = scheduled_iso || null
    let resolvedTimezone = timezone || null
    if (scheduling_mode === 'auto' && !resolvedScheduledIso) {
      const rows = await supaFetch(`profiles?id=eq.${profile_id}&select=timezone,posting_schedule`)
      const profile = rows?.[0]
      if (profile) {
        const taken = await supaFetch(
          `content_scripts?profile_id=eq.${profile_id}&status=eq.scheduled&select=scheduled_datetime`
        ).catch(() => [])
        const takenIso = (taken || []).map((r) => r.scheduled_datetime).filter(Boolean)
        const slot = findNextOpenSlot(profile, takenIso)
        if (slot) {
          resolvedScheduledIso = slot
          resolvedTimezone = resolvedTimezone || profile.timezone
        }
      }
    }

    if (resolvedScheduledIso) {
      fd.append('scheduled_date', resolvedScheduledIso)
      if (resolvedTimezone) fd.append('timezone', resolvedTimezone)
    }

    if (isText) {
      // Text-only posts use /api/upload_text. Append per-platform
      // variant text via *_title-style overrides so each platform
      // publishes its native wording. The base `description` still
      // goes too — Upload-Post uses it as the fallback for any
      // platform without an explicit override.
      const ppt = (per_platform_text && typeof per_platform_text === 'object') ? per_platform_text : {}
      if (ppt.x)         fd.set('x_title',         String(ppt.x).slice(0, 280))
      if (ppt.threads)   fd.set('threads_title',   String(ppt.threads).slice(0, 500))
      if (ppt.facebook)  fd.set('facebook_title',  String(ppt.facebook).slice(0, 5000))
      if (ppt.linkedin)  fd.set('linkedin_title',  String(ppt.linkedin).slice(0, 3000))
    } else if (isVideo) {
      // URL pass-through — Upload-Post fetches the video itself with
      // proper Content-Type detection. Far more reliable than re-uploading
      // bytes as a Blob (which hides codec, lies about extension, and pins
      // us under Vercel's body/timeout limits). async_upload=true tells
      // Upload-Post to process in the background instead of blocking us
      // while strict platforms (LinkedIn, YouTube) chew through the file.
      fd.append('video', video_url)
      fd.append('async_upload', 'true')
    } else {
      for (let i = 0; i < photos.length; i++) {
        const blob = await fetchToBlob(photos[i])
        fd.append('photos[]', blob, `photo-${i}.${ext(photos[i], 'jpg')}`)
      }
    }

    const endpoint = `https://api.upload-post.com/api/${isText ? 'upload_text' : isVideo ? 'upload' : 'upload_photos'}`
    const r = await fetch(endpoint, {
      method: 'POST',
      headers: { Authorization: `Apikey ${apiKey}` },
      body: fd,
    })
    const body = await r.json().catch(() => ({}))
    if (!r.ok) {
      return res.status(502).json({ error: body?.error || body?.message || `Upload-Post error (${r.status})`, raw: body })
    }

    if (customerId) {
      try {
        await supaFetch('rpc/consume_credits', {
          method: 'POST',
          body: {
            p_customer_id: customerId, p_pool_type: 'ai_tokens', p_amount: fee,
            p_action: 'consume:upload-post', p_profile_id: profile_id,
            p_metadata: { platforms, scheduled_iso: resolvedScheduledIso || null, kind: isVideo ? 'video' : 'photos', count: isVideo ? 1 : photos.length },
          },
        })
      } catch {}
    }

    // Persist as a content_scripts row so the post appears on the
    // Schedule page's Calendar view alongside library-scheduled
    // content. status='posted' for instant publishes, 'scheduled' for
    // future ISOs.
    //
    // Dedup window: if a row with the same media_url + profile_id was
    // created in the last 5 minutes, UPDATE that row in place instead
    // of inserting a new one. Prevents two near-simultaneous workflow
    // runs (auto-tick races, double-clicks, retries) from producing
    // duplicate rows in the queue. 5 min is wider than any realistic
    // workflow but tighter than a posting cadence, so legitimate
    // re-renders of the same content separated by hours still create
    // their own rows.
    let savedItem = null
    try {
      const isFuture = !!resolvedScheduledIso && new Date(resolvedScheduledIso).getTime() > Date.now() + 30_000
      const status = isFuture ? 'scheduled' : 'posted'
      const mediaUrls = isText ? [] : (isVideo ? [video_url] : photos)
      const mediaType = isText ? 'text' : (isVideo ? 'video' : 'image')
      const postType = isText ? 'text' : (isVideo ? 'video' : 'post')
      const titleStr = (title || '').trim() || (description || '').slice(0, 60).trim() || 'Scheduled post'
      const primaryMediaUrl = mediaUrls?.[0]
      const fiveMinAgo = new Date(Date.now() - 5 * 60_000).toISOString()

      // When the caller passes script_id (resync flow, edits-on-scheduled
      // -row flow), patch THAT specific row instead of doing the 5-min
      // media-URL lookup. The lookup window is intentionally short to
      // avoid stale matches during normal workflows, but resync runs
      // hours/days after the original create — so without script_id, the
      // lookup misses and a duplicate row gets inserted.
      let existing = null
      if (req.body?.script_id) {
        try {
          const matches = await supaFetch(
            `content_scripts?id=eq.${encodeURIComponent(req.body.script_id)}` +
            `&select=id,status`
          )
          existing = Array.isArray(matches) ? matches[0] : null
        } catch { /* fall through to lookup */ }
      }
      if (!existing && primaryMediaUrl) {
        const matches = await supaFetch(
          `content_scripts?profile_id=eq.${profile_id}` +
          `&media_urls=cs.{${encodeURIComponent('"' + primaryMediaUrl + '"')}}` +
          `&created_at=gte.${encodeURIComponent(fiveMinAgo)}` +
          `&order=created_at.desc&limit=1&select=id,status`
        ).catch(() => [])
        existing = Array.isArray(matches) ? matches[0] : null
      }

      // Resolve copy fields for the queue row. Prefer explicit fields
      // from the request body (sent by the schedule_post node so each
      // piece lands in its own column). If the caller only sent the
      // legacy merged `description`, do a best-effort split: hashtags
      // are the trailing #-token block, caption is everything before.
      let caption = (rawCaption || '').toString().trim()
      let hashtags = (rawHashtags || '').toString().trim()
      let firstComment = (rawFirstComment || '').toString().trim()
      const script = (rawScript || '').toString().trim()
      if (!caption && !hashtags && description) {
        const desc = String(description).trim()
        // Match a trailing run of "#tags" (one or more, allowing line
        // breaks between caption and tags). Anything before is caption.
        const m = desc.match(/^([\s\S]*?)\s*((?:#[\w\-]+\s*)+)$/)
        if (m) {
          caption = (m[1] || '').trim()
          hashtags = (m[2] || '').trim()
        } else {
          caption = desc
        }
      }
      // Default first_comment to hashtags so Instagram "drop hashtags in
      // first comment" workflows have something to publish out of the
      // box. Caller can override with an explicit first_comment field.
      if (!firstComment && hashtags) firstComment = hashtags

      // Upload-Post returns the request_id on success — pull it out of
      // the response body now so we can persist it on the row. Without
      // this, scheduled-but-not-yet-fired posts have no way for us to
      // look up their delivery status (the status endpoint is keyed
      // entirely on request_id).
      const uploadpostRequestId = body?.request_id || body?.id || null
      // Also capture the INTERNAL job_id. Per the documented schedule-
      // posts API, cancellations key on job_id (DELETE /api/uploadposts
      // /schedule/<job_id>) and the list endpoint only exposes job_id,
      // not request_id. Without persisting this here, every later
      // cancel had to scan a list looking for request_id — which the
      // current API doesn't return, so cancels silently failed.
      const uploadpostJobId =
        body?.job_id ||
        body?.jobId ||
        body?.schedule?.job_id ||
        body?.scheduled?.job_id ||
        null

      const payload = {
        profile_id,
        title: titleStr,
        full_script: script || null,         // the raw script that drove this post (not the rendered description)
        caption: caption || null,
        hashtags: hashtags || null,
        first_comment: firstComment || null,
        media_urls: mediaUrls,
        media_type: mediaType,
        post_type: postType,
        platforms,
        status,
        scheduled_datetime: resolvedScheduledIso || null,
        uploadpost_request_id: uploadpostRequestId,
        uploadpost_job_id: uploadpostJobId,
        generated_by: 'schedule_post',
        // Per-platform text variants for text-only posts. Stored as
        // jsonb so the Schedule page can paginate through them like
        // the canvas does, and the resync / edit-on-row flows can
        // submit each platform's native wording instead of one shared
        // caption.
        per_platform_text: isText ? (per_platform_text || null) : null,
      }
      if (existing?.id) {
        // Same media inserted moments ago — patch the existing row
        // (e.g. update status from scheduled→posted, or refresh
        // scheduled_datetime). No new queue slot.
        const updated = await supaFetch(`content_scripts?id=eq.${existing.id}`, { method: 'PATCH', body: payload })
        savedItem = Array.isArray(updated) ? updated[0] : updated
      } else {
        const inserted = await supaFetch('content_scripts', { method: 'POST', body: payload })
        savedItem = Array.isArray(inserted) ? inserted[0] : inserted
      }
    } catch (e) {
      console.warn('schedule_post → content_scripts persist failed:', e.message)
    }

    // Backfill uploadpost_job_id from the Upload-Post schedule list.
    // Upload-Post doesn't return job_id in the submission response —
    // only request_id — so the only way to capture job_id (which is
    // what their cancel/PATCH endpoints key on) is to fetch the list
    // right after the job is indexed. Indexing takes a second or two,
    // so we try a couple times with a short backoff. Best-effort: if
    // we can't find it, the row's saved request_id + scheduled_datetime
    // is enough for the cascade-cancel flow to recover via title+date
    // match. Fire-and-forget so it doesn't slow down the response.
    if (savedItem?.id && resolvedScheduledIso && uploadpostRequestId) {
      ;(async () => {
        try {
          const { resolveUploadpostUser, uploadpostListScheduled } = await import('../_lib/uploadpost.js')
          const usernameForList = await resolveUploadpostUser(profile_id).catch(() => null)
          if (!usernameForList) return
          const targetMs = Date.parse(resolvedScheduledIso)
          const titleKey = (titleStr || '').trim().toLowerCase().slice(0, 40)
          // Three tries: 1s, 3s, 6s after submit — Upload-Post indexes
          // new jobs into the schedule list within a few seconds in
          // our testing.
          for (const wait of [1000, 2000, 3000]) {
            await new Promise((r) => setTimeout(r, wait))
            const raw = await uploadpostListScheduled(usernameForList).catch(() => ({ posts: [] }))
            const jobs = Array.isArray(raw?.posts) ? raw.posts : []
            const match = jobs.find((j) => {
              if (!j?.job_id) return false
              const jobMs = Date.parse(j.scheduled_date || j.scheduled_at || '')
              if (!Number.isFinite(targetMs) || !Number.isFinite(jobMs)) return false
              if (Math.abs(jobMs - targetMs) > 60_000) return false
              if (titleKey && j.title) {
                const jt = String(j.title).trim().toLowerCase().slice(0, 40)
                if (jt !== titleKey) return false
              }
              return true
            })
            if (match?.job_id) {
              await supaFetch(`content_scripts?id=eq.${savedItem.id}`, {
                method: 'PATCH',
                body: { uploadpost_job_id: match.job_id },
                prefer: 'return=minimal',
              }).catch(() => {})
              break
            }
          }
        } catch (e) {
          console.warn('post-submit job_id backfill failed:', e?.message)
        }
      })().catch(() => {})
    }

    // Best-effort notification — bell pings instantly via Realtime.
    // Distinguish scheduled-for-later vs published-now so the user gets
    // a "queued" ping when they actually queue, and a separate "live"
    // ping later when the scheduler fires it.
    const isFuture = resolvedScheduledIso && new Date(resolvedScheduledIso).getTime() > Date.now() + 5000
    if (isFuture) {
      NotifyKind.postScheduled({
        user_id: auth.user.id,
        profile_id,
        platforms,
        scheduled_for: resolvedScheduledIso,
        title: savedItem?.title || null,
      }).catch(() => {})
    } else {
      NotifyKind.postPublished({
        user_id: auth.user.id,
        profile_id,
        platforms,
      }).catch(() => {})
    }

    return res.status(200).json({
      request_id: body?.request_id || body?.id || null,
      submitted: true,
      scheduled_iso: resolvedScheduledIso || null,
      content_id: savedItem?.id || null,
      raw: body,
    })
  } catch (err) {
    console.error('upload-post error:', err?.stack || err)
    // Surface the failure as a notification too — without this the user
    // sees a red node and no inbox trail.
    try {
      const auth = await requireUser(req, res)
      if (auth?.user?.id) {
        NotifyKind.postFailed({
          user_id: auth.user.id,
          profile_id: req.body?.profile_id,
          error: String(err?.message || err).slice(0, 280),
        }).catch(() => {})
      }
    } catch {}
    return res.status(err.status || 500).json({ error: String(err?.message || err) })
  }
}
