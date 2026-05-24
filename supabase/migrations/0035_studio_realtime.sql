-- Stream studio_videos + studio_segments through Realtime so the video
-- map UI can update segment status (generating_image, ready, error)
-- and parent video status (mapping, mapped, rendering, rendered) live
-- as the orchestrator updates rows in the background.
--
-- Without this publication entry the subscription silently delivers
-- nothing — same gotcha as credit_pools (0029) and space_runs (0030).
alter publication supabase_realtime add table public.studio_videos;
alter publication supabase_realtime add table public.studio_segments;
