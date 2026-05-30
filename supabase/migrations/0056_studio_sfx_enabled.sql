-- Per-video SFX toggle. Mirrors overlays_enabled / motion_graphics_enabled:
-- when false, the worker skips the SFX mix pass entirely (no
-- entrance/exit/transition/emphasis cues, no standalone events).
--
-- Default true so existing videos behave the same as before this
-- column existed. The re-render modal surfaces a checkbox so users
-- can flip it off per-bake.

ALTER TABLE studio_videos
  ADD COLUMN IF NOT EXISTS sfx_enabled BOOLEAN NOT NULL DEFAULT true;

COMMENT ON COLUMN studio_videos.sfx_enabled IS
  'When false the worker skips the SFX mix pass entirely (no entrance/exit/transition/emphasis cues, no standalone events). Mirror of overlays_enabled but for sound design. Default true.';
