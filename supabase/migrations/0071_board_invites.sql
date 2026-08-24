-- Editor invites. An owner/admin invites a video editor by email; a pending row
-- is created, and when that email first signs in (via the magic link) it is
-- claimed into a profile_access row (role='contributor', allowed_pages=['board']).
-- If the email already has an account, the grant happens immediately at invite
-- time and the row is marked accepted.
create table if not exists public.board_invites (
  id uuid primary key default gen_random_uuid(),
  email text not null,                       -- lowercased
  profile_id uuid not null references public.profiles(id) on delete cascade,
  role text not null default 'contributor',
  invited_by uuid references auth.users(id) on delete set null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'revoked')),
  created_at timestamptz not null default now(),
  accepted_at timestamptz,
  unique (email, profile_id)
);

create index if not exists board_invites_email_idx on public.board_invites (email);
create index if not exists board_invites_profile_idx on public.board_invites (profile_id);

alter table public.board_invites enable row level security;
-- Only brand admins/owners manage invites (the API uses the service key anyway;
-- this keeps any client-token read scoped).
drop policy if exists board_invites_admin on public.board_invites;
create policy board_invites_admin on public.board_invites
  for all using (public.has_profile_access(profile_id, 'admin'))
  with check (public.has_profile_access(profile_id, 'admin'));
