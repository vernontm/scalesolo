-- ============================================================================
-- M3: AI CEO memory layer
-- pgvector + persistent conversations + pinned facts + retrievable knowledge
-- chunks. All scoped per profile (the brand). Strict RLS via has_profile_access.
-- ============================================================================

create extension if not exists vector;

-- ──────────────────────────────────────────────────────────────────────────
-- agent_conversations — one thread; multiple per profile.
-- ──────────────────────────────────────────────────────────────────────────
create table public.agent_conversations (
  id           uuid primary key default gen_random_uuid(),
  profile_id   uuid not null references public.profiles(id) on delete cascade,
  user_id      uuid not null,                 -- auth.users.id of the creator
  title        text,                          -- auto-generated from first message
  is_archived  boolean default false,
  created_at   timestamptz default now(),
  updated_at   timestamptz default now()
);
create index agent_conv_profile_recent on public.agent_conversations(profile_id, updated_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- agent_messages — append-only chat log. Content is jsonb to support
-- multimodal (text + image blocks) and tool-use payloads.
-- ──────────────────────────────────────────────────────────────────────────
create table public.agent_messages (
  id              uuid primary key default gen_random_uuid(),
  conversation_id uuid not null references public.agent_conversations(id) on delete cascade,
  profile_id      uuid not null references public.profiles(id) on delete cascade,
  role            text not null check (role in ('user','assistant','tool','system')),
  content         jsonb not null,             -- e.g. [{type:"text",text:"..."}]
  -- token accounting (for usage display + audit)
  input_tokens    int,
  output_tokens   int,
  pinned          boolean default false,      -- user can pin individual messages
  created_at      timestamptz default now()
);
create index agent_msg_conv_created on public.agent_messages(conversation_id, created_at);

-- ──────────────────────────────────────────────────────────────────────────
-- agent_pinned_facts — short, always-included-in-system-prompt rules.
-- ──────────────────────────────────────────────────────────────────────────
create table public.agent_pinned_facts (
  id          uuid primary key default gen_random_uuid(),
  profile_id  uuid not null references public.profiles(id) on delete cascade,
  fact        text not null,
  source      text default 'manual'           -- 'manual' or 'message:<msg_id>'
    check (source in ('manual','message','onboarding')),
  source_ref  uuid,
  created_at  timestamptz default now()
);
create index agent_pinned_profile on public.agent_pinned_facts(profile_id, created_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- agent_knowledge_chunks — embedded brand bible / past content / custom notes.
-- Retrieved via cosine similarity per chat turn.
-- ──────────────────────────────────────────────────────────────────────────
create table public.agent_knowledge_chunks (
  id            uuid primary key default gen_random_uuid(),
  profile_id    uuid not null references public.profiles(id) on delete cascade,
  source        text not null check (source in ('brand_bible','custom_note','past_content')),
  source_ref    uuid,                         -- e.g. content_scripts.id
  chunk_index   int default 0,
  chunk_text    text not null,
  embedding     vector(1536),                 -- text-embedding-3-small
  metadata      jsonb default '{}'::jsonb,
  created_at    timestamptz default now()
);
create index agent_chunks_profile on public.agent_knowledge_chunks(profile_id);
create index agent_chunks_source  on public.agent_knowledge_chunks(profile_id, source);
-- ivfflat index for fast cosine search (build with reasonable lists count)
create index agent_chunks_embedding
  on public.agent_knowledge_chunks
  using ivfflat (embedding vector_cosine_ops) with (lists = 100);

-- ──────────────────────────────────────────────────────────────────────────
-- Retrieval RPC: top-k chunks for a given query embedding, scoped by profile.
-- Returns (chunk_text, source, similarity) — service-role only, called from
-- the chat endpoint after embedding the user's message.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.match_knowledge(
  p_profile_id uuid,
  p_embedding  vector(1536),
  p_match_count int default 5,
  p_min_similarity numeric default 0.5
)
returns table (id uuid, source text, chunk_text text, similarity float, metadata jsonb)
language sql
security definer
stable
as $$
  select id, source, chunk_text,
         1 - (embedding <=> p_embedding) as similarity,
         metadata
    from public.agent_knowledge_chunks
   where profile_id = p_profile_id
     and embedding is not null
     and 1 - (embedding <=> p_embedding) >= p_min_similarity
   order by embedding <=> p_embedding
   limit p_match_count;
$$;
grant execute on function public.match_knowledge(uuid, vector, int, numeric) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Triggers
-- ──────────────────────────────────────────────────────────────────────────
drop trigger if exists trg_touch_agent_conv on public.agent_conversations;
create trigger trg_touch_agent_conv before update on public.agent_conversations
  for each row execute function public.touch_updated_at();

-- Bump conversation.updated_at whenever a new message lands (for sorting).
create or replace function public.bump_conversation_on_message() returns trigger as $$
begin
  update public.agent_conversations
    set updated_at = now()
    where id = new.conversation_id;
  return new;
end;
$$ language plpgsql;

drop trigger if exists trg_bump_conv_on_msg on public.agent_messages;
create trigger trg_bump_conv_on_msg after insert on public.agent_messages
  for each row execute function public.bump_conversation_on_message();

-- ──────────────────────────────────────────────────────────────────────────
-- RLS
-- ──────────────────────────────────────────────────────────────────────────
alter table public.agent_conversations    enable row level security;
alter table public.agent_messages         enable row level security;
alter table public.agent_pinned_facts     enable row level security;
alter table public.agent_knowledge_chunks enable row level security;

do $$
declare t text;
begin
  for t in select unnest(array[
    'agent_conversations','agent_messages','agent_pinned_facts','agent_knowledge_chunks'
  ]) loop
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
        using (public.has_profile_access(profile_id, 'editor'));
    $f$, t);
  end loop;
end $$;
