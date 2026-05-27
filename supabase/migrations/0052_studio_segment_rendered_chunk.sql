-- Persistent per-segment rendered chunk. Each baked segment gets
-- uploaded to studio-media storage as soon as it finishes rendering,
-- and the URL is stored here. On a subsequent bake, the worker
-- short-circuits any segment whose chunk URL is already set + still
-- reachable, so a 51/52 bake that loses its machine to suspend/deploy/
-- crash can resume from where it left off instead of redoing 50 min
-- of work.
--
-- The URL is also surfaced in the Studio UI as a small inline preview
-- per segment so the user sees each chunk land as it bakes.
--
-- Invalidation: api/studio/segments.js clears this on every PATCH so
-- edits to script_text, voice_url, hyperframes_variables, overlay
-- placements, transition, etc. force a re-render. The worker re-runs
-- generate-assets on regen too, which already clears voice/image URLs,
-- so this column comes along for the ride.

alter table public.studio_segments
  add column if not exists rendered_chunk_url text;

comment on column public.studio_segments.rendered_chunk_url is
  'Supabase Storage URL for the per-segment baked chunk. Worker writes on success; cleared on any PATCH so edits invalidate it.';
