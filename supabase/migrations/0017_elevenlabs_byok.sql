-- BYOK ElevenLabs. Brand profiles can connect their own ElevenLabs API
-- key so they can use voices that aren't in our shared workspace.
-- The encrypted key never leaves the server; the SPA only sees a
-- masked last-4 + a connected timestamp. See api/_lib/crypto.js for
-- AES-256-GCM encryption + ELEVENLABS_KEY_SECRET env var.

alter table public.profiles
  add column if not exists elevenlabs_api_key_encrypted text,
  add column if not exists elevenlabs_api_key_last4 text,
  add column if not exists elevenlabs_connected_at timestamptz;

-- Each avatar tags which API key its voice_id resolves under so the
-- render flow picks the right one. 'shared' = our master key (used
-- for premade library voices + voices we clone in our workspace);
-- 'byok' = the brand profile's connected key.
alter table public.avatars
  add column if not exists voice_owner text not null default 'shared'
    check (voice_owner in ('shared', 'byok'));
