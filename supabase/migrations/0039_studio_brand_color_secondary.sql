-- Secondary brand accent on studio videos. Pairs with brand_color
-- (primary) so template gradients, glows, and dual-color treatments
-- can render in the user's brand palette instead of the template's
-- defaults. Both are nullable — null falls back to the template's
-- own primary/secondary.

ALTER TABLE studio_videos
  ADD COLUMN IF NOT EXISTS brand_color_secondary TEXT;

COMMENT ON COLUMN studio_videos.brand_color_secondary IS
  'Secondary brand accent (hex). Pairs with brand_color (primary) to
   drive template gradients, glows, and dual-color treatments. Null
   falls back to the template default.';
