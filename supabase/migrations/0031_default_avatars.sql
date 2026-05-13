-- Default avatars — admin-curated avatars that show up on every user's
-- /avatars page, pre-hooked with an ElevenLabs voice. Users can pick
-- one and render with it without doing any setup work. They cannot
-- edit the avatar or its looks; they CAN swap the voice to a different
-- ElevenLabs voice via default_avatar_voice_overrides below.

create table public.default_avatars (
  id                    uuid primary key default gen_random_uuid(),
  name                  text not null,
  description           text,
  heygen_group_id       text,                 -- the HeyGen avatar group admins built once
  elevenlabs_voice_id   text,                 -- the pre-hooked default voice
  default_voice_label   text,                 -- human-readable: "Kara (warm Houston AAVE)"
  preview_image_url     text,                 -- hero thumbnail for the card
  sort_order            int default 0,
  is_active             boolean default true, -- soft-delete; old renders keep working
  created_by            uuid references auth.users(id) on delete set null,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now()
);
create index default_avatars_active_idx on public.default_avatars (is_active, sort_order);

-- Looks for default avatars. Same shape as avatar_looks but no
-- profile_id (admins own these, not user profiles).
create table public.default_avatar_looks (
  id                   uuid primary key default gen_random_uuid(),
  default_avatar_id    uuid not null references public.default_avatars(id) on delete cascade,
  heygen_look_id       text,
  image_url            text not null,
  label                text,
  angle_order          int default 0,
  created_at           timestamptz default now()
);
create index default_avatar_looks_parent_idx on public.default_avatar_looks (default_avatar_id, angle_order);
create unique index default_avatar_looks_heygen_unique
  on public.default_avatar_looks (default_avatar_id, heygen_look_id) where heygen_look_id is not null;

-- Per-user voice override for default avatars. NULL voice_id means
-- "use the avatar's default voice." A row here means the user wants
-- a different ElevenLabs voice when rendering with that default
-- avatar — typically their own cloned voice.
create table public.default_avatar_voice_overrides (
  user_id              uuid not null references auth.users(id) on delete cascade,
  default_avatar_id    uuid not null references public.default_avatars(id) on delete cascade,
  elevenlabs_voice_id  text not null,
  voice_label          text,           -- optional human-friendly name the user typed
  updated_at           timestamptz default now(),
  primary key (user_id, default_avatar_id)
);

-- ── RLS ───────────────────────────────────────────────────────────────
alter table public.default_avatars                  enable row level security;
alter table public.default_avatar_looks             enable row level security;
alter table public.default_avatar_voice_overrides   enable row level security;

-- Default avatars: any authenticated user can READ active rows. Only
-- admins (user_profiles.is_admin = true) can write.
create policy default_avatars_select_active on public.default_avatars
  for select to authenticated
  using (is_active = true);
create policy default_avatars_admin_all on public.default_avatars
  for all to authenticated
  using (exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_admin = true))
  with check (exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_admin = true));

-- Default avatar looks: read mirrors the parent (anyone can read looks
-- of an active default avatar). Admin-only writes.
create policy default_avatar_looks_select on public.default_avatar_looks
  for select to authenticated
  using (exists (
    select 1 from public.default_avatars da
    where da.id = default_avatar_id and da.is_active = true
  ));
create policy default_avatar_looks_admin_all on public.default_avatar_looks
  for all to authenticated
  using (exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_admin = true))
  with check (exists (select 1 from public.user_profiles up where up.id = auth.uid() and up.is_admin = true));

-- Voice overrides: each user only sees / writes their own row.
create policy default_avatar_voice_overrides_self on public.default_avatar_voice_overrides
  for all to authenticated
  using (user_id = auth.uid())
  with check (user_id = auth.uid());
