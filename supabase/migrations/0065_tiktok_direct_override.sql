-- Per-post TikTok mode override. NULL = follow the brand profile's
-- tiktok_draft_mode; true = force DIRECT_POST to the feed for this post;
-- false = force MEDIA_UPLOAD (inbox draft) for this post. Read at
-- submit time by /api/social/upload-post and bulk publish.

alter table content_scripts
  add column if not exists tiktok_direct_override boolean;

comment on column content_scripts.tiktok_direct_override is
  'Per-post TikTok mode: null=brand default, true=force direct post, false=force draft.';
