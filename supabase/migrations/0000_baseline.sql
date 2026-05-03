-- ============================================================================
-- ScaleSolo baseline migration
-- Apply this to a brand-new Supabase project (not VTM's).
-- All tables are multi-tenant via profile_id, scoped through profile_access.
-- Strict RLS from line 1: no permissive USING (true) policies.
-- ============================================================================

create extension if not exists "uuid-ossp";
create extension if not exists pgcrypto;

-- ──────────────────────────────────────────────────────────────────────────
-- profiles — the brand profile (tenant). One workspace can have many profiles.
-- ──────────────────────────────────────────────────────────────────────────
create table public.profiles (
  id                       uuid primary key default gen_random_uuid(),
  business_name            text not null,
  owner_name               text,
  industry                 text,
  business_type            text,                                   -- creator, coach, consultant, e-commerce, freelancer, other
  website_url              text,
  brand_bible              text,
  brand_primary_color      text,
  brand_secondary_color    text,
  logo_url                 text,
  preferred_tone           text,
  target_audience          text,
  core_hashtags            text,
  location                 text,
  timezone                 text default 'UTC',
  -- social handles + cached IDs
  instagram_handle         text,
  tiktok_handle            text,
  facebook_handle          text,
  threads_handle           text,
  youtube_handle           text,
  linkedin_handle          text,
  x_handle                 text,
  instagram_id             text,
  tiktok_id                text,
  facebook_id              text,
  threads_id               text,
  youtube_id               text,
  linkedin_id              text,
  -- platform integration
  uploadpost_user          text,
  uploadpost_platforms     text[] default array['tiktok','instagram'],
  autodm_reply_message     text,
  carousel_templates       jsonb default '{}'::jsonb,
  threads_style            jsonb default '{}'::jsonb,
  enabled_pages            text[] default array['*'],
  -- AI CEO behavior dial (used in M3)
  agent_aggressiveness     text default 'balanced' check (agent_aggressiveness in ('quiet','balanced','aggressive')),
  is_active                boolean default true,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);
create index profiles_business_name_idx on public.profiles(business_name);

-- ──────────────────────────────────────────────────────────────────────────
-- profile_access — multi-tenant grants. Composite PK.
-- ──────────────────────────────────────────────────────────────────────────
create table public.profile_access (
  user_id        uuid not null,
  profile_id     uuid not null references public.profiles(id) on delete cascade,
  role           text not null default 'viewer' check (role in ('owner','admin','editor','viewer')),
  allowed_pages  text[] not null default array['*'],
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now(),
  primary key (user_id, profile_id)
);
create index profile_access_profile_idx on public.profile_access(profile_id);

-- Helper used by RLS — note: marked SECURITY DEFINER + STABLE for perf.
create or replace function public.has_profile_access(p_profile_id uuid, p_min_role text default 'viewer')
returns boolean
language sql
security definer
stable
as $$
  select exists (
    select 1
    from public.profile_access
    where user_id = auth.uid()
      and profile_id = p_profile_id
      and case p_min_role
            when 'owner'  then role = 'owner'
            when 'admin'  then role in ('owner','admin')
            when 'editor' then role in ('owner','admin','editor')
            else true
          end
  );
$$;
grant execute on function public.has_profile_access(uuid, text) to authenticated;

-- ──────────────────────────────────────────────────────────────────────────
-- avatars — one row per AI character (HeyGen group + ElevenLabs voice clone)
-- ──────────────────────────────────────────────────────────────────────────
create table public.avatars (
  id                        uuid primary key default gen_random_uuid(),
  profile_id                uuid not null references public.profiles(id) on delete cascade,
  name                      text not null,
  heygen_group_id           text,
  elevenlabs_voice_id       text,
  logo_url                  text,
  logo_position             text default 'tr' check (logo_position in ('tl','tr','bl','br')),
  logo_size_pct             numeric default 12,
  caption_style             jsonb default '{"font":"Montserrat","size":64,"color":"#FFFFFF","highlight":"#ef4444","y_position":0.75,"words_per_chunk":2,"stroke":"#000000","stroke_width":6}'::jsonb,
  title_style               jsonb default '{"font":"Plus Jakarta Sans","size":72,"color":"#FFFFFF","stroke":"#000000","stroke_width":6}'::jsonb,
  default_music_url         text,
  default_volume            numeric default 0.15 check (default_volume between 0 and 1),
  default_fade_secs         numeric default 1.5,
  created_at                timestamptz default now(),
  updated_at                timestamptz default now()
);
create index avatars_profile_idx on public.avatars(profile_id);

create table public.avatar_outfits (
  id            uuid primary key default gen_random_uuid(),
  avatar_id     uuid not null references public.avatars(id) on delete cascade,
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  name          text not null,
  sort_order    int default 0,
  created_at    timestamptz default now()
);
create index avatar_outfits_avatar_idx  on public.avatar_outfits(avatar_id);
create index avatar_outfits_profile_idx on public.avatar_outfits(profile_id);

create table public.avatar_looks (
  id              uuid primary key default gen_random_uuid(),
  avatar_id       uuid not null references public.avatars(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  outfit_id       uuid references public.avatar_outfits(id) on delete set null,
  heygen_look_id  text,
  image_url       text not null,
  angle_order     int default 0,
  created_at      timestamptz default now()
);
create index avatar_looks_avatar_idx  on public.avatar_looks(avatar_id);
create index avatar_looks_profile_idx on public.avatar_looks(profile_id);
create unique index avatar_looks_heygen_unique
  on public.avatar_looks(avatar_id, heygen_look_id) where heygen_look_id is not null;

create table public.avatar_renders (
  id                  uuid primary key default gen_random_uuid(),
  avatar_id           uuid not null references public.avatars(id) on delete cascade,
  profile_id          uuid not null references public.profiles(id) on delete cascade,
  outfit_id           uuid references public.avatar_outfits(id) on delete set null,
  title               text,
  script              text not null,
  sentences           jsonb not null default '[]'::jsonb,
  music_url           text,
  music_volume        numeric,
  music_fade_secs     numeric,
  caption_style       jsonb,
  title_style         jsonb,
  logo_url            text,
  logo_position       text,
  final_video_url     text,
  duration_secs       numeric,
  status              text not null default 'draft'
    check (status in ('draft','pending','generating_audio','generating_clips','stitching','done','failed')),
  error               text,
  logs                jsonb not null default '[]'::jsonb,
  scheduled_post_id   uuid,
  created_at          timestamptz default now(),
  updated_at          timestamptz default now()
);
create index avatar_renders_status_idx  on public.avatar_renders(status);
create index avatar_renders_profile_idx on public.avatar_renders(profile_id);

-- ──────────────────────────────────────────────────────────────────────────
-- content_scripts — unified post record (video / image / carousel / text)
-- ──────────────────────────────────────────────────────────────────────────
create table public.content_scripts (
  id                       uuid primary key default gen_random_uuid(),
  profile_id               uuid not null references public.profiles(id) on delete cascade,
  title                    text,
  hook                     text,
  full_script              text default '',
  series_name              text,
  caption                  text,
  hashtags                 text,
  first_comment            text,
  tags                     text,
  media_urls               text[],
  media_type               text default 'video',           -- video / image / carousel / text
  scheduled_datetime       timestamptz,
  status                   text default 'draft',           -- draft / caption_ready / scheduled / posted / failed
  sort_order               int,
  post_type                text default 'post',
  location                 text,
  uploadpost_request_id    text,
  publish_status           text,                            -- publishing / posted / failed
  publish_error            text,
  cover_timestamp          int,
  platforms                text[],
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);
create index content_scripts_profile_idx   on public.content_scripts(profile_id);
create index content_scripts_status_idx    on public.content_scripts(status);
create index content_scripts_scheduled_idx on public.content_scripts(scheduled_datetime);

-- ──────────────────────────────────────────────────────────────────────────
-- auto_schedule_config — per-profile publish slots
-- ──────────────────────────────────────────────────────────────────────────
create table public.auto_schedule_config (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  time_slots   text[] not null default array['10:00','14:00','18:00','22:00'],
  timezone     text default 'America/Chicago',
  is_active    boolean default true,
  created_at   timestamptz default now(),
  unique (profile_id)
);

-- ──────────────────────────────────────────────────────────────────────────
-- email — config, contacts, campaigns, templates, tag context, mailerlite cache
-- ──────────────────────────────────────────────────────────────────────────
create table public.email_config (
  id                    uuid primary key default uuid_generate_v4(),
  profile_id            uuid not null references public.profiles(id) on delete cascade,
  email_provider        text default 'postmark' check (email_provider in ('postmark','mailerlite')),
  postmark_server_token text,
  mailerlite_api_key    text,
  from_email            text not null,
  from_name             text default '',
  reply_to_email        text,
  daily_limit           int default 1000,
  created_at            timestamptz default now(),
  updated_at            timestamptz default now(),
  unique (profile_id)
);

create table public.email_contacts (
  id                          uuid primary key default uuid_generate_v4(),
  profile_id                  uuid not null references public.profiles(id) on delete cascade,
  email                       text not null,
  name                        text default '',
  phone                       text,
  tags                        jsonb default '[]'::jsonb,
  status                      text default 'active' check (status in ('active','unsubscribed','bounced','complained')),
  source                      text,
  signed_up_at                timestamptz,
  welcomed_at                 timestamptz,
  birthday_month              smallint,
  birthday_day                smallint,
  discount_code               text,
  city                        text,
  state                       text,
  country                     text,
  mailerlite_subscriber_id    text,
  mailerlite_synced_at        timestamptz,
  created_at                  timestamptz default now(),
  updated_at                  timestamptz default now(),
  unique (profile_id, email)
);
create index email_contacts_profile_idx on public.email_contacts(profile_id);
create index email_contacts_tags_idx    on public.email_contacts using gin (tags);

create table public.email_templates (
  id              uuid primary key default uuid_generate_v4(),
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  name            text not null,
  subject         text not null,
  preview_text    text,
  html_body       text not null default '',
  template_type   text default 'blast' check (template_type in ('welcome','blast','transactional')),
  is_default      boolean default false,
  created_at      timestamptz default now(),
  updated_at      timestamptz default now()
);

create table public.email_campaigns (
  id                       uuid primary key default uuid_generate_v4(),
  profile_id               uuid not null references public.profiles(id) on delete cascade,
  subject                  text not null,
  preview_text             text,
  html_body                text not null default '',
  tag_filter               jsonb default '[]'::jsonb,
  status                   text default 'draft' check (status in ('draft','scheduled','sending','sent','partial','failed')),
  scheduled_at             timestamptz,
  sent_at                  timestamptz,
  trigger_type             text default 'broadcast' check (trigger_type in ('broadcast','tag')),
  trigger_on_tag           text,
  auto_trigger_enabled     boolean default false,
  total_recipients         int default 0,
  sent_count               int default 0,
  failed_count             int default 0,
  opened_count             int default 0,
  clicked_count            int default 0,
  mailerlite_campaign_id   text,
  created_at               timestamptz default now(),
  updated_at               timestamptz default now()
);
create index email_campaigns_profile_idx on public.email_campaigns(profile_id);
create index email_campaigns_status_idx  on public.email_campaigns(status);

create table public.email_tag_context (
  id           uuid primary key default uuid_generate_v4(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  tag          text not null,
  description  text default '',
  created_at   timestamptz default now(),
  updated_at   timestamptz default now(),
  unique (profile_id, tag)
);

create table public.mailerlite_groups (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  tag          text not null,
  group_id     text not null,
  group_name   text,
  synced_at    timestamptz default now(),
  unique (profile_id, tag)
);

-- ──────────────────────────────────────────────────────────────────────────
-- analytics_snapshots — daily per-profile rollups
-- ──────────────────────────────────────────────────────────────────────────
create table public.analytics_snapshots (
  id                uuid primary key default gen_random_uuid(),
  profile_id        uuid not null references public.profiles(id) on delete cascade,
  snapshot_date     date not null default current_date,
  period            text not null default 'last_7_days',
  platforms         text not null default 'instagram,tiktok',
  analytics_data    jsonb,
  impressions_data  jsonb,
  narrative         text,                                  -- AI-generated insight (M6)
  created_at        timestamptz default now(),
  updated_at        timestamptz default now()
);
create index analytics_snapshots_profile_date_idx on public.analytics_snapshots(profile_id, snapshot_date desc);

-- ──────────────────────────────────────────────────────────────────────────
-- updated_at triggers
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.touch_updated_at() returns trigger as $$
begin new.updated_at = now(); return new; end;
$$ language plpgsql;

do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'profiles','profile_access','avatars','avatar_renders',
      'content_scripts','email_config','email_contacts','email_templates',
      'email_campaigns','email_tag_context','analytics_snapshots'
    ])
  loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on public.%1$I; create trigger trg_touch_%1$s before update on public.%1$I for each row execute function public.touch_updated_at();',
      t
    );
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- Row-Level Security: strict policies via profile_access from line 1.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.profiles            enable row level security;
alter table public.profile_access      enable row level security;
alter table public.avatars             enable row level security;
alter table public.avatar_outfits      enable row level security;
alter table public.avatar_looks        enable row level security;
alter table public.avatar_renders      enable row level security;
alter table public.content_scripts     enable row level security;
alter table public.auto_schedule_config enable row level security;
alter table public.email_config        enable row level security;
alter table public.email_contacts      enable row level security;
alter table public.email_templates     enable row level security;
alter table public.email_campaigns     enable row level security;
alter table public.email_tag_context   enable row level security;
alter table public.mailerlite_groups   enable row level security;
alter table public.analytics_snapshots enable row level security;

-- profile_access: a user can read their own grants; only owners can grant new access.
create policy access_select_self on public.profile_access
  for select to authenticated
  using (user_id = auth.uid());

create policy access_modify_owner on public.profile_access
  for all to authenticated
  using (public.has_profile_access(profile_id, 'owner'))
  with check (public.has_profile_access(profile_id, 'owner'));

-- profiles: read if you have any access; modify if owner or admin; create requires owner grant added separately by API.
create policy profiles_select on public.profiles
  for select to authenticated
  using (public.has_profile_access(id, 'viewer'));

create policy profiles_insert on public.profiles
  for insert to authenticated
  with check (true);   -- API also creates the owner grant in the same call

create policy profiles_update on public.profiles
  for update to authenticated
  using (public.has_profile_access(id, 'admin'))
  with check (public.has_profile_access(id, 'admin'));

create policy profiles_delete on public.profiles
  for delete to authenticated
  using (public.has_profile_access(id, 'owner'));

-- Generic policy generator for tables with profile_id.
do $$
declare
  t text;
begin
  for t in
    select unnest(array[
      'avatars','avatar_outfits','avatar_looks','avatar_renders',
      'content_scripts','auto_schedule_config',
      'email_config','email_contacts','email_templates','email_campaigns',
      'email_tag_context','mailerlite_groups','analytics_snapshots'
    ])
  loop
    execute format($f$
      create policy %1$I_select on public.%1$I
        for select to authenticated
        using (public.has_profile_access(profile_id, 'viewer'));

      create policy %1$I_insert on public.%1$I
        for insert to authenticated
        with check (public.has_profile_access(profile_id, 'editor'));

      create policy %1$I_update on public.%1$I
        for update to authenticated
        using (public.has_profile_access(profile_id, 'editor'))
        with check (public.has_profile_access(profile_id, 'editor'));

      create policy %1$I_delete on public.%1$I
        for delete to authenticated
        using (public.has_profile_access(profile_id, 'admin'));
    $f$, t);
  end loop;
end $$;

-- service_role bypasses RLS by default — used by all serverless endpoints
-- via SUPABASE_SERVICE_KEY. No additional grants needed.

-- ──────────────────────────────────────────────────────────────────────────
-- Done. Subsequent migrations live alongside this file:
--   0001_billing.sql      (M1)
--   0002_credits.sql      (M2)
--   0003_agent_memory.sql (M3)
--   ...
-- ──────────────────────────────────────────────────────────────────────────
