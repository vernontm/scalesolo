-- Per-brand TikTok Draft (MEDIA_UPLOAD) mode.
--
-- When true, TikTok posts for this brand are submitted to Upload-Post with
-- tiktok_post_mode=MEDIA_UPLOAD, which lands the post in the user's TikTok
-- inbox/drafts to publish natively from the app. TikTok's own guidance is
-- that app-published posts get more organic reach than API direct posts.
--
-- Caveat handled by the brand workflow: in Draft mode TikTok ignores the
-- caption/hashtags sent via API, so the copy is delivered to the user
-- separately (e.g. texted) to paste in the app before publishing.

alter table profiles
  add column if not exists tiktok_draft_mode boolean not null default false;

comment on column profiles.tiktok_draft_mode is
  'When true, TikTok posts for this brand are sent as MEDIA_UPLOAD (Draft/Inbox) so the user publishes natively from the TikTok app for better organic reach. TikTok drops the caption in this mode, so the workflow texts the caption/hashtags separately.';

-- RayvaughnCEO (uploadpost_user = rayvaughnceo): draft mode on, and stop
-- forcing direct posts (the retry-to-feed chain is the opposite of draft).
update profiles
set tiktok_draft_mode = true,
    tiktok_force_direct_post = false
where uploadpost_user = 'rayvaughnceo';
