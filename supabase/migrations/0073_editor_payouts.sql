-- Editor payouts. Editors are paid a flat per-video rate (a monthly deal ÷ a
-- monthly quota, e.g. $800/mo ÷ 60 reels ≈ $13.33/approved video). A video
-- becomes payable the moment its card is Approved. Overage is uncapped (every
-- approved video earns) and shortfall rolls over (unfinished quota accumulates
-- as videos owed). Phase A tracks + records manual payments; Phase B adds the
-- USDT-on-Solana send.

-- When a card was first approved (stamped once, never cleared, so it survives
-- later stage changes) + which payout covered it (unpaid ⇔ approved & no payout).
alter table public.board_cards
  add column if not exists approved_at timestamptz,
  add column if not exists payout_id uuid;

create index if not exists board_cards_approved_idx
  on public.board_cards (assigned_editor_email, approved_at)
  where approved_at is not null;

-- One compensation deal per editor (email-keyed like board_invites). Rate is
-- derived: monthly_amount / nullif(monthly_quota,0). solana_address is set by
-- the editor themselves on their Payouts page.
create table if not exists public.editor_comp (
  email text primary key,
  monthly_amount numeric not null default 0,
  monthly_quota int not null default 0,
  started_on date not null default now(),
  solana_address text,
  is_active boolean not null default true,
  updated_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

-- Append-only payout ledger (mirrors credit_transactions). Phase A rows are
-- manual ("mark paid"); Phase B fills tx_signature with the on-chain send.
create table if not exists public.editor_payouts (
  id uuid primary key default gen_random_uuid(),
  editor_email text not null,
  editor_user_id uuid references auth.users(id) on delete set null,
  amount_usdt numeric not null default 0,
  video_count int not null default 0,
  status text not null default 'sent' check (status in ('pending', 'sent', 'confirmed', 'failed')),
  tx_signature text,
  note text,
  created_by uuid references auth.users(id) on delete set null,
  created_at timestamptz not null default now()
);
create unique index if not exists editor_payouts_txsig_idx
  on public.editor_payouts (tx_signature) where tx_signature is not null;
create index if not exists editor_payouts_email_idx on public.editor_payouts (editor_email, created_at desc);

-- RLS: the API uses the service key (bypasses RLS). Lock direct client access:
-- editor_comp readable/writable by its owner (matched by email) is enforced in
-- the API; keep RLS closed by default here.
alter table public.editor_comp enable row level security;
alter table public.editor_payouts enable row level security;
-- No permissive policies: only service_role (the API) touches these tables.
