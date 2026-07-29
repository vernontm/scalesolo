-- Campaign media generation tracking. The generator (Phase 2/3) turns a
-- post's media_brief into real images/carousels/videos via Kie, then
-- writes the results into content_scripts.media_urls. These columns make
-- generation resumable (the in-flight Kie task ids survive a function
-- timeout so a re-invoke polls instead of re-submitting and double-
-- charging) and surface progress/errors in the UI.

ALTER TABLE content_scripts
  ADD COLUMN IF NOT EXISTS media_gen_status TEXT
    CHECK (media_gen_status IN ('idle', 'generating', 'ready', 'failed')),
  -- In-flight Kie job handles for this post, e.g.
  -- { kind:'image'|'video', image_task:'<id>', video_task:'<id>', count:N }.
  ADD COLUMN IF NOT EXISTS media_jobs JSONB,
  ADD COLUMN IF NOT EXISTS media_gen_error TEXT;

COMMENT ON COLUMN content_scripts.media_gen_status IS
  'Campaign media generation state: idle (not started), generating (Kie job in flight), ready (media_urls populated), failed. NULL = never attempted.';
COMMENT ON COLUMN content_scripts.media_jobs IS
  'In-flight Kie task ids for resumable media generation so a function timeout does not re-submit (and re-charge). Cleared on success.';
