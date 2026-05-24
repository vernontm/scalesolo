-- Track per-chunk bake progress so the frontend can show a real
-- progress bar during long renders. Also tracks which motion-graphics
-- segments rendered with the real HyperFrames composition vs the
-- ffmpeg drawtext fallback, so the UI can warn when the template
-- didn't fully kick in.
--
-- Shape:
--   {
--     "stage": "baking" | "concat" | "upload" | "done",
--     "current": 12,
--     "total": 24,
--     "started_at": "2026-05-24T22:00:00Z",
--     "hf_rendered": ["seg-id-1", "seg-id-2"],   -- real HyperFrames bake
--     "hf_fallback": [{ "seg_id": "...", "reason": "..." }]  -- drawtext stub used
--   }
alter table public.studio_videos
  add column if not exists render_progress jsonb;
