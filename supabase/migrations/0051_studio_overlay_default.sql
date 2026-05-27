-- Belt-and-suspenders default for studio_segments.overlay_placements.
-- The column is NOT NULL, but several insert paths historically forgot
-- to set it (manual POST /api/studio/segments, voiceover-segment bulk
-- insert, the v1 split RPC). We've patched each call site, but a DB
-- default closes the loop so a future caller can't trip the constraint.

alter table public.studio_segments
  alter column overlay_placements set default '[]'::jsonb;
