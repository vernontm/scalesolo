-- ============================================================================
-- M1: ScaleSolo platform billing
-- billing_customers + billing_subscriptions hold our own Stripe billing state.
-- stripe_events provides idempotency for re-delivered webhooks.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- billing_customers — one Stripe customer per workspace (= per auth.users.id)
-- ──────────────────────────────────────────────────────────────────────────
create table public.billing_customers (
  id                  uuid primary key default gen_random_uuid(),
  user_id             uuid not null unique,                -- auth.users.id of the workspace owner
  stripe_customer_id  text unique,
  email               text not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);
create index billing_customers_stripe_idx on public.billing_customers(stripe_customer_id);

-- ──────────────────────────────────────────────────────────────────────────
-- billing_subscriptions — current ScaleSolo subscription state per customer
-- ──────────────────────────────────────────────────────────────────────────
create table public.billing_subscriptions (
  id                       uuid primary key default gen_random_uuid(),
  customer_id              uuid not null references public.billing_customers(id) on delete cascade,
  stripe_subscription_id   text unique,
  stripe_price_id          text not null,
  tier                     text not null check (tier in ('solo_starter','solo_pro','solo_studio','founding')),
  billing_cycle            text not null default 'monthly' check (billing_cycle in ('monthly','annual','lifetime')),
  status                   text not null,                  -- trialing, active, past_due, canceled, incomplete, incomplete_expired, unpaid
  trial_end                timestamptz,
  current_period_start     timestamptz,
  current_period_end       timestamptz,
  cancel_at_period_end     boolean default false,
  canceled_at              timestamptz,
  profile_limit            int not null default 1,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index billing_subs_customer_idx on public.billing_subscriptions(customer_id);
create index billing_subs_status_idx   on public.billing_subscriptions(status);

-- ──────────────────────────────────────────────────────────────────────────
-- stripe_events — idempotency for webhook re-delivery
-- ──────────────────────────────────────────────────────────────────────────
create table public.stripe_events (
  id              uuid primary key default gen_random_uuid(),
  stripe_event_id text not null unique,                    -- Stripe sends evt_... ids
  event_type      text not null,                           -- e.g. customer.subscription.updated
  payload         jsonb not null,
  processed_at    timestamptz,
  error           text,
  created_at      timestamptz not null default now()
);
create index stripe_events_type_idx on public.stripe_events(event_type, created_at desc);

-- ──────────────────────────────────────────────────────────────────────────
-- founding_member_count — atomic counter for the 100-spot offer
-- (single-row table, not technically necessary but cleaner than a sequence)
-- ──────────────────────────────────────────────────────────────────────────
create table public.founding_member_count (
  id           int primary key default 1 check (id = 1),
  claimed      int not null default 0,
  cap          int not null default 100,
  updated_at   timestamptz not null default now()
);
insert into public.founding_member_count (id, claimed, cap) values (1, 0, 100);

-- Atomic claim helper. Returns true if claim succeeded, false if cap reached.
create or replace function public.claim_founding_spot()
returns boolean
language plpgsql
security definer
as $$
declare
  v_claimed int;
  v_cap     int;
begin
  update public.founding_member_count
    set claimed = claimed + 1,
        updated_at = now()
    where id = 1 and claimed < cap
    returning claimed, cap into v_claimed, v_cap;
  return v_claimed is not null;
end;
$$;
grant execute on function public.claim_founding_spot() to authenticated, anon, service_role;

-- updated_at triggers (touch_updated_at defined in 0000_baseline.sql)
do $$
declare t text;
begin
  for t in select unnest(array['billing_customers','billing_subscriptions'])
  loop
    execute format(
      'drop trigger if exists trg_touch_%1$s on public.%1$I; create trigger trg_touch_%1$s before update on public.%1$I for each row execute function public.touch_updated_at();',
      t
    );
  end loop;
end $$;

-- ──────────────────────────────────────────────────────────────────────────
-- RLS: a user can only read their own billing rows. Service role writes.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.billing_customers       enable row level security;
alter table public.billing_subscriptions   enable row level security;
alter table public.stripe_events           enable row level security;
alter table public.founding_member_count   enable row level security;

create policy billing_customers_select_self on public.billing_customers
  for select to authenticated
  using (user_id = auth.uid());

create policy billing_subs_select_self on public.billing_subscriptions
  for select to authenticated
  using (
    exists (
      select 1 from public.billing_customers c
      where c.id = billing_subscriptions.customer_id and c.user_id = auth.uid()
    )
  );

-- founding count: anyone can read (used on public pricing page); only service_role writes.
create policy founding_count_select_all on public.founding_member_count
  for select to authenticated, anon
  using (true);

-- stripe_events: service_role only. No policies for authenticated/anon (default deny).
