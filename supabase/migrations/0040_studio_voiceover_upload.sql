-- Voiceover-upload flow. User provides a pre-recorded MP3, we
-- transcribe + segment it into beats, slice the master into per-
-- segment voice files, and skip ElevenLabs synth entirely.
--
-- Columns added:
--   studio_videos.voiceover_source_url   master MP3 in studio-media
--   studio_videos.voiceover_transcript   Scribe word-level transcript
--   studio_segments.voice_source_start_secs / _end_secs
--     start + end of this segment's slice within the master voiceover,
--     so re-slicing is non-destructive (the master MP3 stays put).

ALTER TABLE studio_videos
  ADD COLUMN IF NOT EXISTS voiceover_source_url TEXT,
  ADD COLUMN IF NOT EXISTS voiceover_transcript JSONB;

ALTER TABLE studio_segments
  ADD COLUMN IF NOT EXISTS voice_source_start_secs REAL,
  ADD COLUMN IF NOT EXISTS voice_source_end_secs   REAL;

COMMENT ON COLUMN studio_videos.voiceover_source_url IS
  'When set, the user provided a pre-recorded voiceover. Path to the master MP3 in studio-media. ElevenLabs voice synth is skipped — the worker uses per-segment slices instead.';
COMMENT ON COLUMN studio_videos.voiceover_transcript IS
  'Cached ElevenLabs Scribe response (word-level timestamps) for the uploaded voiceover. Used to re-slice if segmentation is regenerated.';
COMMENT ON COLUMN studio_segments.voice_source_start_secs IS
  'For uploaded-voiceover videos: start position of this segment in the master voiceover (seconds).';
