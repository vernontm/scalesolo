-- Video production board: a native Kanban that replaces the Notion approval
-- flow. Cards move raw -> editing -> in_review -> needs_revisions -> approved
-- -> scheduled. Each card holds a version history (raw footage + editor edits,
-- all stored in our own landing-media Supabase bucket) and a feedback comment
-- thread. On "Send to Schedule" an approved card spawns a content_scripts draft
-- that flows into the existing scheduler, so there is no new posting code.
--
-- RLS mirrors the profile_access model used by content_scripts et al. The API
-- reads/writes through the service key (bypasses RLS); the policies exist so the
-- browser's authenticated client could read/subscribe safely.

create table if not exists public.board_cards (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  title text not null default 'Untitled',
  stage text not null default 'raw'
    check (stage in ('raw','editing','in_review','needs_revisions','approved','scheduled')),
  position double precision not null default 0,          -- ordering within a column
  assigned_editor uuid references auth.users(id) on delete set null,
  final_version_id uuid,                                 -- FK added after the versions table exists
  content_script_id uuid references public.content_scripts(id) on delete set null, -- set on Send to Schedule
  source_note text,                                      -- e.g. original raw / Dropbox reference
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists public.board_card_versions (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.board_cards(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,  -- denormalized for RLS
  version_no int not null default 1,
  video_url text not null,
  thumbnail_url text,
  kind text not null default 'edit' check (kind in ('raw','edit')),
  note text,
  uploaded_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);

create table if not exists public.board_card_comments (
  id uuid primary key default gen_random_uuid(),
  card_id uuid not null references public.board_cards(id) on delete cascade,
  profile_id uuid not null references public.profiles(id) on delete cascade,  -- denormalized for RLS
  author_id uuid references auth.users(id) on delete set null,
  body text not null,
  created_at timestamptz not null default now()
);

-- final_version_id -> versions (added after both tables exist to avoid a cycle)
alter table public.board_cards drop constraint if exists board_cards_final_version_fk;
alter table public.board_cards
  add constraint board_cards_final_version_fk
  foreign key (final_version_id) references public.board_card_versions(id) on delete set null;

create index if not exists board_cards_profile_idx
  on public.board_cards (profile_id, stage, position);
create index if not exists board_card_versions_card_idx
  on public.board_card_versions (card_id, version_no);
create index if not exists board_card_comments_card_idx
  on public.board_card_comments (card_id, created_at);

comment on table public.board_cards is
  'Video production Kanban card. Lifecycle raw->editing->in_review->needs_revisions->approved->scheduled; on approve+send it spawns a content_scripts draft (content_script_id).';

-- RLS: profile_access-based, same helper as content_scripts.
alter table public.board_cards enable row level security;
alter table public.board_card_versions enable row level security;
alter table public.board_card_comments enable row level security;

drop policy if exists board_cards_select on public.board_cards;
create policy board_cards_select on public.board_cards for select using (public.has_profile_access(profile_id));
drop policy if exists board_cards_insert on public.board_cards;
create policy board_cards_insert on public.board_cards for insert with check (public.has_profile_access(profile_id));
drop policy if exists board_cards_update on public.board_cards;
create policy board_cards_update on public.board_cards for update using (public.has_profile_access(profile_id));
drop policy if exists board_cards_delete on public.board_cards;
create policy board_cards_delete on public.board_cards for delete using (public.has_profile_access(profile_id));

drop policy if exists board_card_versions_select on public.board_card_versions;
create policy board_card_versions_select on public.board_card_versions for select using (public.has_profile_access(profile_id));
drop policy if exists board_card_versions_insert on public.board_card_versions;
create policy board_card_versions_insert on public.board_card_versions for insert with check (public.has_profile_access(profile_id));
drop policy if exists board_card_versions_update on public.board_card_versions;
create policy board_card_versions_update on public.board_card_versions for update using (public.has_profile_access(profile_id));
drop policy if exists board_card_versions_delete on public.board_card_versions;
create policy board_card_versions_delete on public.board_card_versions for delete using (public.has_profile_access(profile_id));

drop policy if exists board_card_comments_select on public.board_card_comments;
create policy board_card_comments_select on public.board_card_comments for select using (public.has_profile_access(profile_id));
drop policy if exists board_card_comments_insert on public.board_card_comments;
create policy board_card_comments_insert on public.board_card_comments for insert with check (public.has_profile_access(profile_id));
drop policy if exists board_card_comments_delete on public.board_card_comments;
create policy board_card_comments_delete on public.board_card_comments for delete using (public.has_profile_access(profile_id));
