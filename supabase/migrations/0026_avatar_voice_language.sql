-- BCP-47 language code on avatars. Without this ElevenLabs auto-detects
-- per chunk and we've seen a few renders drift from English mid-script
-- when the input had ambiguous tokens (numbers, brand names, code).
-- Pinning the language makes the language stable across the whole
-- script. Null defaults to model auto-detect for backwards compat.
alter table public.avatars
  add column if not exists voice_language text;
comment on column public.avatars.voice_language is
  'BCP-47 language code passed to ElevenLabs TTS (en, es, fr, etc). Null = let model auto-detect (drifts).';
