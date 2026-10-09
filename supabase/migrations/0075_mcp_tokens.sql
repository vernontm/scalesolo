-- Per-person MCP access tokens (ports the pattern already proven in the VTM
-- CRM's crm_mcp_tokens). One row per person, so access is revocable
-- individually (active=false) without rotating everyone else's, and every
-- call is attributable.
--
-- The token travels in the URL (?token=...) because connector forms in
-- Claude Desktop / claude.ai have no field for a custom header. That makes
-- the URL itself the credential: treat it like a password.

create table if not exists public.scalesolo_mcp_tokens (
  id          uuid primary key default gen_random_uuid(),
  name        text        not null,                       -- who it is for
  token       text        not null unique,                -- the secret in the URL
  -- readonly: look only. draft: write captions + generate, never publish.
  -- publish: everything the remote endpoint exposes.
  role        text        not null default 'readonly'
                check (role in ('readonly', 'draft', 'publish')),
  -- Brand allowlist. NULL or empty = every brand on the account.
  profile_ids uuid[],
  active      boolean     not null default true,
  last_used   timestamptz,
  created_by  uuid,
  created_at  timestamptz not null default now()
);

create index if not exists scalesolo_mcp_tokens_token_idx
  on public.scalesolo_mcp_tokens (token) where active;

-- Audit trail: every tool call made through a token. Live posting runs
-- through here, so "who posted that" must be answerable.
create table if not exists public.scalesolo_mcp_audit (
  id         uuid primary key default gen_random_uuid(),
  token_id   uuid references public.scalesolo_mcp_tokens(id) on delete set null,
  token_name text,
  token_role text,
  tool       text not null,
  args       jsonb,
  result     text,
  is_error   boolean not null default false,
  ip         text,
  created_at timestamptz not null default now()
);

create index if not exists scalesolo_mcp_audit_created_idx
  on public.scalesolo_mcp_audit (created_at desc);

-- Service-role only: the MCP endpoint reads these with the service key, and
-- no browser client should ever see raw tokens.
alter table public.scalesolo_mcp_tokens enable row level security;
alter table public.scalesolo_mcp_audit  enable row level security;
