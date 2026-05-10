-- Per-avatar ElevenLabs voice settings. Lets users dial in stability,
-- similarity_boost, style, speed, speaker boost, and model selection
-- per avatar instead of every render using the same hardcoded preset.
--
-- voice_settings is the full ElevenLabs voice_settings object plus
-- our `speed` extension (the API exposes speed on Turbo v2.5+ / v3).
-- voice_model_id picks the TTS model — Turbo / Multilingual / v3.

alter table public.avatars
  add column if not exists voice_settings jsonb,
  add column if not exists voice_model_id text;

comment on column public.avatars.voice_settings is
  'ElevenLabs voice_settings JSON: { stability, similarity_boost, style, use_speaker_boost, speed }. Null = use system defaults.';
comment on column public.avatars.voice_model_id is
  'ElevenLabs TTS model id (e.g. eleven_turbo_v2_5, eleven_multilingual_v2, eleven_v3). Null = use system default.';
