-- 0011_content_uniqueness.sql
-- Per-brand content history with embeddings, used to keep future generations
-- distinct from what's already been written for that brand.
--
-- Every successful script_gen / caption_gen result is embedded with
-- text-embedding-3-small (1536 dims) and stored here. Before generating
-- new content, the API embeds the topic and pulls the top-K most-similar
-- past pieces to feed back into the system prompt as "avoid repeating".

create extension if not exists vector;

create table if not exists public.content_history (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  content_id    uuid references public.content_scripts(id) on delete set null,
  kind          text not null check (kind in ('script','caption','hashtags','topic','image_prompt')),
  topic         text,
  text          text not null,
  embedding     vector(1536),
  source        text default 'space',          -- 'space' | 'agent' | 'manual'
  created_at    timestamptz not null default now()
);

create index if not exists content_history_profile_recent_idx
  on public.content_history (profile_id, created_at desc);

create index if not exists content_history_embedding_idx
  on public.content_history using ivfflat (embedding vector_cosine_ops)
  with (lists = 100);

-- RPC: cosine-similarity search across a brand's history.
create or replace function public.match_content_history(
  p_profile_id      uuid,
  p_query_embedding vector(1536),
  p_match_count     int default 5,
  p_min_similarity  float default 0.0,
  p_kinds           text[] default null
)
returns table (
  id            uuid,
  kind          text,
  topic         text,
  text          text,
  similarity    float,
  created_at    timestamptz
)
language sql stable as $$
  select
    h.id,
    h.kind,
    h.topic,
    h.text,
    1 - (h.embedding <=> p_query_embedding) as similarity,
    h.created_at
  from public.content_history h
  where h.profile_id = p_profile_id
    and h.embedding is not null
    and (p_kinds is null or h.kind = any (p_kinds))
    and 1 - (h.embedding <=> p_query_embedding) > p_min_similarity
  order by h.embedding <=> p_query_embedding
  limit p_match_count;
$$;

-- RLS — same pattern as agent_* tables.
alter table public.content_history enable row level security;

create policy content_history_select on public.content_history
  for select to authenticated
  using (public.has_profile_access(profile_id, 'viewer'));

create policy content_history_insert on public.content_history
  for insert to authenticated
  with check (public.has_profile_access(profile_id, 'editor'));

create policy content_history_update on public.content_history
  for update to authenticated
  using (public.has_profile_access(profile_id, 'editor'))
  with check (public.has_profile_access(profile_id, 'editor'));

create policy content_history_delete on public.content_history
  for delete to authenticated
  using (public.has_profile_access(profile_id, 'editor'));
