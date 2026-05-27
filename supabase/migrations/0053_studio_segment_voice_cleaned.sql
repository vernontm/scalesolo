-- Tracks whether a segment's voice_url has been run through ElevenLabs
-- Voice Isolator. The fly worker /jobs/voice-isolate-segments endpoint
-- processes user-uploaded voiceovers asynchronously (each isolation
-- call can take 20-60s, which is far over Vercel's 300s function
-- ceiling). The flag prevents re-cleaning on retries / re-renders.
--
-- Set to true after a successful isolation. Cleared back to false
-- whenever voice_url is replaced (regen, manual re-upload) so the
-- cleaned slice gets a fresh pass on the new audio.

alter table public.studio_segments
  add column if not exists voice_cleaned boolean not null default false;

comment on column public.studio_segments.voice_cleaned is
  'True when voice_url has been run through ElevenLabs Voice Isolator. Cleared on voice_url change.';
