-- Affiliate program schema. Already applied to prod via MCP; this file
-- exists so fresh environments + branch DBs can bootstrap from migration.
-- Ships with the columns and indexes required by:
--   /api/affiliate*, /api/admin/affiliates*, /api/_lib/affiliate.js
--   stripe-webhook recordAffiliateCommission + clawbackAffiliateCommission

create table if not exists public.affiliates (
  id uuid primary key default gen_random_uuid(),
  user_id uuid not null references auth.users(id) on delete cascade,
  code text not null unique,
  tier text not null default 'starter' check (tier in ('starter','pro','elite')),
  status text not null default 'pending' check (status in ('pending','approved','suspended')),
  paypal_email text,
  display_name text,
  notes text,
  created_at timestamptz not null default now(),
  approved_at timestamptz,
  constraint affiliates_user_unique unique (user_id)
);
create index if not exists affiliates_code_idx   on public.affiliates (code);
create index if not exists affiliates_status_idx on public.affiliates (status);

create table if not exists public.affiliate_referrals (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  referred_user_id uuid not null references auth.users(id) on delete cascade,
  signed_up_at timestamptz not null default now(),
  first_paid_at timestamptz,
  constraint affiliate_referrals_user_unique unique (referred_user_id)
);
create index if not exists affiliate_referrals_affiliate_idx on public.affiliate_referrals (affiliate_id);

create table if not exists public.affiliate_commissions (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  referral_id uuid references public.affiliate_referrals(id) on delete set null,
  stripe_invoice_id text not null,
  stripe_customer_id text,
  gross_amount_cents integer not null,
  commission_rate numeric(5,4) not null,
  commission_cents integer not null,
  currency text not null default 'usd',
  status text not null default 'pending' check (status in ('pending','approved','paid','clawed_back')),
  payout_id uuid,
  invoice_paid_at timestamptz not null,
  created_at timestamptz not null default now(),
  constraint affiliate_commissions_invoice_unique unique (stripe_invoice_id)
);
create index if not exists affiliate_commissions_affiliate_idx on public.affiliate_commissions (affiliate_id);
create index if not exists affiliate_commissions_status_idx    on public.affiliate_commissions (status);
-- Hot path for the monthly-close cron: status='pending' AND
-- invoice_paid_at < cutoff. Partial index keeps it tiny.
create index if not exists affiliate_commissions_pending_old_idx
  on public.affiliate_commissions (invoice_paid_at)
  where status = 'pending';

create table if not exists public.affiliate_payouts (
  id uuid primary key default gen_random_uuid(),
  affiliate_id uuid not null references public.affiliates(id) on delete cascade,
  total_cents integer not null,
  currency text not null default 'usd',
  paypal_email text,
  status text not null default 'pending' check (status in ('pending','sent','failed')),
  external_ref text,
  notes text,
  paid_at timestamptz,
  created_at timestamptz not null default now()
);

alter table public.affiliate_commissions
  drop constraint if exists affiliate_commissions_payout_fk;
alter table public.affiliate_commissions
  add constraint affiliate_commissions_payout_fk
  foreign key (payout_id) references public.affiliate_payouts(id) on delete set null;

-- RLS: users read their own rows; service-role writes via API endpoints.
alter table public.affiliates           enable row level security;
alter table public.affiliate_referrals  enable row level security;
alter table public.affiliate_commissions enable row level security;
alter table public.affiliate_payouts    enable row level security;

drop policy if exists affiliates_self_read on public.affiliates;
create policy affiliates_self_read on public.affiliates
  for select using (auth.uid() = user_id);

drop policy if exists affiliate_referrals_self_read on public.affiliate_referrals;
create policy affiliate_referrals_self_read on public.affiliate_referrals
  for select using (
    exists (select 1 from public.affiliates a where a.id = affiliate_id and a.user_id = auth.uid())
  );

drop policy if exists affiliate_commissions_self_read on public.affiliate_commissions;
create policy affiliate_commissions_self_read on public.affiliate_commissions
  for select using (
    exists (select 1 from public.affiliates a where a.id = affiliate_id and a.user_id = auth.uid())
  );

drop policy if exists affiliate_payouts_self_read on public.affiliate_payouts;
create policy affiliate_payouts_self_read on public.affiliate_payouts
  for select using (
    exists (select 1 from public.affiliates a where a.id = affiliate_id and a.user_id = auth.uid())
  );
