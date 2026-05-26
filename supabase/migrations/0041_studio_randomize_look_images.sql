-- Randomize-look-images toggle on studio_videos. When TRUE the bake
-- cycles different images from the chosen look across the avatar
-- segments instead of using the same image throughout.

ALTER TABLE studio_videos
  ADD COLUMN IF NOT EXISTS randomize_look_images BOOLEAN NOT NULL DEFAULT FALSE;

COMMENT ON COLUMN studio_videos.randomize_look_images IS
  'When true, each avatar segment renders with a different image from the chosen look (cycled deterministically). When false, every avatar segment uses the same look image.';
