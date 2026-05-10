-- Brand voice training. Lets users teach the platform their voice
-- + tastes per brand profile. Generation pulls from these tables to
-- few-shot prompt with examples + rules.

create table if not exists public.brand_scripts (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  text text not null,
  hook text,
  format text,
  source text default 'user_paste',
  notes text,
  rating smallint not null default 0 check (rating in (-1, 0, 1)),
  use_count int not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists brand_scripts_profile_idx
  on public.brand_scripts(profile_id, rating desc, created_at desc);

create table if not exists public.brand_hooks (
  id uuid primary key default gen_random_uuid(),
  profile_id uuid not null references public.profiles(id) on delete cascade,
  hook text not null,
  rating smallint not null default 0 check (rating in (-1, 0, 1)),
  source text default 'user',
  use_count int not null default 0,
  created_at timestamptz not null default now()
);
create index if not exists brand_hooks_profile_idx
  on public.brand_hooks(profile_id, rating desc);

create table if not exists public.script_formats (
  key text primary key,
  label text not null,
  description text,
  prompt_directive text not null,
  example text,
  active boolean not null default true,
  sort_order int not null default 100,
  created_at timestamptz not null default now()
);

create table if not exists public.viral_library (
  id uuid primary key default gen_random_uuid(),
  text text not null,
  hook text,
  format text,
  niche text,
  source_url text,
  notes text,
  active boolean not null default true,
  added_by uuid references auth.users(id),
  created_at timestamptz not null default now()
);
create index if not exists viral_library_active_niche_idx
  on public.viral_library(niche, active) where active = true;

alter table public.profiles
  add column if not exists do_not_say jsonb not null default '[]'::jsonb,
  add column if not exists always_include jsonb not null default '[]'::jsonb,
  add column if not exists default_formats jsonb not null default '[]'::jsonb;

alter table public.brand_scripts  enable row level security;
alter table public.brand_hooks    enable row level security;
alter table public.script_formats enable row level security;
alter table public.viral_library  enable row level security;

drop policy if exists brand_scripts_select on public.brand_scripts;
create policy brand_scripts_select on public.brand_scripts
  for select using (has_profile_access(profile_id, 'viewer'));
drop policy if exists brand_scripts_insert on public.brand_scripts;
create policy brand_scripts_insert on public.brand_scripts
  for insert with check (has_profile_access(profile_id, 'editor'));
drop policy if exists brand_scripts_update on public.brand_scripts;
create policy brand_scripts_update on public.brand_scripts
  for update using (has_profile_access(profile_id, 'editor'))
              with check (has_profile_access(profile_id, 'editor'));
drop policy if exists brand_scripts_delete on public.brand_scripts;
create policy brand_scripts_delete on public.brand_scripts
  for delete using (has_profile_access(profile_id, 'editor'));

drop policy if exists brand_hooks_select on public.brand_hooks;
create policy brand_hooks_select on public.brand_hooks
  for select using (has_profile_access(profile_id, 'viewer'));
drop policy if exists brand_hooks_insert on public.brand_hooks;
create policy brand_hooks_insert on public.brand_hooks
  for insert with check (has_profile_access(profile_id, 'editor'));
drop policy if exists brand_hooks_update on public.brand_hooks;
create policy brand_hooks_update on public.brand_hooks
  for update using (has_profile_access(profile_id, 'editor'))
              with check (has_profile_access(profile_id, 'editor'));
drop policy if exists brand_hooks_delete on public.brand_hooks;
create policy brand_hooks_delete on public.brand_hooks
  for delete using (has_profile_access(profile_id, 'editor'));

drop policy if exists script_formats_select on public.script_formats;
create policy script_formats_select on public.script_formats
  for select using (true);

-- Seed format catalog. ON CONFLICT DO NOTHING so re-running is safe.
insert into public.script_formats (key, label, description, prompt_directive, sort_order) values
  ('story',          'Personal story',     'Open with a vivid scene from a real-feeling moment, then tie to the lesson.', 'Open with a vivid 1-2 sentence scene that drops the viewer mid-action. Then transition to the universal insight. End with a tight payoff or question.', 1),
  ('listicle',       '5/7/9 list',         'Numbered list with a punchy intro and tight items.',                          'Open with a curiosity-gap hook that promises the list. Each item is 1-2 sentences max, parallel structure, increasing payoff. End with a CTA.', 2),
  ('hot_take',       'Hot take',           'Bold contrarian claim, then defend it.',                                       'Lead with an unambiguous, slightly provocative claim that contradicts conventional wisdom. Spend 60% defending it concretely. Don''t hedge.', 3),
  ('myth_bust',      'Myth bust',          'Common belief stated, then demolished.',                                       'Open by stating a belief many people have. Pivot with "Here''s what''s actually happening." Lay out the truth concretely.', 4),
  ('before_after',   'Before / after',     'Show transformation by contrast.',                                             'Open with the painful "before" state in concrete detail. Pivot with what changed. Land with the "after" state, equally concrete. Show the bridge.', 5),
  ('problem_solution','Problem → solution','Name the problem, prescribe the fix.',                                         'Sentence 1: name a specific painful problem the audience faces. Sentence 2-3: surface what most people try and why it fails. Sentence 4+: the actual fix, with a concrete first step.', 6),
  ('q_and_a',        'Q & A',              'A question the audience asked, then your answer.',                             'Open with a question phrased as if a real follower asked it. Answer it directly, with a specific example or framework.', 7),
  ('curiosity_gap',  'Curiosity gap',      'Open with an irresistible knowledge gap.',                                     'First sentence creates an information gap the viewer NEEDS closed. Don''t resolve it for at least 2 sentences. The reveal pays off the setup.', 8)
on conflict (key) do nothing;
