-- ============================================================================
-- M2: Credit system
-- 3 pools (ai_tokens, video_units, voice_minutes) scoped per billing_customer
-- (workspace), not per profile. Tiers grant a monthly amount; the cron resets
-- balances on the first of each month. Top-ups are one-off Stripe purchases.
-- ============================================================================

-- ──────────────────────────────────────────────────────────────────────────
-- credit_pools — current balance per (workspace, pool)
-- ──────────────────────────────────────────────────────────────────────────
create table public.credit_pools (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.billing_customers(id) on delete cascade,
  pool_type       text not null check (pool_type in ('ai_tokens','video_units','voice_minutes')),
  balance         numeric not null default 0,
  monthly_grant   numeric not null default 0,
  last_reset_at   timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  unique (customer_id, pool_type)
);
create index credit_pools_customer_idx on public.credit_pools(customer_id);

-- ──────────────────────────────────────────────────────────────────────────
-- credit_transactions — append-only audit log
-- ──────────────────────────────────────────────────────────────────────────
create table public.credit_transactions (
  id              uuid primary key default gen_random_uuid(),
  customer_id     uuid not null references public.billing_customers(id) on delete cascade,
  pool_type       text not null,
  delta           numeric not null,                  -- negative = consume, positive = grant/topup
  action          text not null,                     -- 'subscription_initial', 'monthly_grant', 'topup', 'consume:<endpoint>', 'admin_adjust'
  ref_table       text,                              -- e.g. 'avatar_renders'
  ref_id          text,                              -- string so we can store stripe ids too
  balance_after   numeric not null,
  profile_id      uuid references public.profiles(id) on delete set null,  -- which profile triggered (null for grants/topups)
  metadata        jsonb default '{}'::jsonb,
  created_at      timestamptz not null default now()
);
create index credit_tx_customer_created on public.credit_transactions(customer_id, created_at desc);
create index credit_tx_action on public.credit_transactions(action);
-- Idempotency: a single (customer, action, ref_id) tuple can only land once
-- (e.g. Stripe topup checkout id, monthly grant year+month, subscription initial id).
create unique index credit_tx_idem on public.credit_transactions(customer_id, pool_type, action, ref_id) where ref_id is not null;

-- ──────────────────────────────────────────────────────────────────────────
-- Atomic consume: SELECT FOR UPDATE → check → decrement → log
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.consume_credits(
  p_customer_id uuid,
  p_pool_type   text,
  p_amount      numeric,
  p_action      text,
  p_ref_table   text default null,
  p_ref_id      text default null,
  p_profile_id  uuid default null,
  p_metadata    jsonb default '{}'::jsonb
)
returns table (success boolean, balance_after numeric, error_code text)
language plpgsql
security definer
as $$
declare
  v_balance numeric;
  v_pool_id uuid;
begin
  if p_amount <= 0 then
    return query select false, 0::numeric, 'invalid_amount';
    return;
  end if;

  -- Lock the pool row for the duration of the txn
  select id, balance into v_pool_id, v_balance
    from public.credit_pools
    where customer_id = p_customer_id and pool_type = p_pool_type
    for update;

  if not found then
    return query select false, 0::numeric, 'pool_missing';
    return;
  end if;

  if v_balance < p_amount then
    return query select false, v_balance, 'insufficient';
    return;
  end if;

  v_balance := v_balance - p_amount;

  update public.credit_pools
    set balance = v_balance, updated_at = now()
    where id = v_pool_id;

  insert into public.credit_transactions
    (customer_id, pool_type, delta, action, ref_table, ref_id, balance_after, profile_id, metadata)
    values (p_customer_id, p_pool_type, -p_amount, p_action, p_ref_table, p_ref_id, v_balance, p_profile_id, p_metadata);

  return query select true, v_balance, null::text;
end;
$$;
grant execute on function public.consume_credits(uuid, text, numeric, text, text, text, uuid, jsonb) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Idempotent grant: returns the new balance, or NULL if the (customer, action, ref_id)
-- tuple was already applied. Service-role only.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.grant_credits(
  p_customer_id uuid,
  p_pool_type   text,
  p_amount      numeric,
  p_action      text,
  p_ref_id      text,
  p_metadata    jsonb default '{}'::jsonb
)
returns numeric
language plpgsql
security definer
as $$
declare
  v_pool_id uuid;
  v_balance numeric;
begin
  if p_amount <= 0 then return null; end if;

  -- Idempotency check (per pool — different pools can share a ref_id, e.g. one subscription_id)
  if p_ref_id is not null and exists (
    select 1 from public.credit_transactions
    where customer_id = p_customer_id
      and pool_type   = p_pool_type
      and action      = p_action
      and ref_id      = p_ref_id
  ) then
    return null;
  end if;

  -- Upsert pool
  insert into public.credit_pools (customer_id, pool_type, balance)
    values (p_customer_id, p_pool_type, 0)
    on conflict (customer_id, pool_type) do nothing;

  select id, balance into v_pool_id, v_balance
    from public.credit_pools
    where customer_id = p_customer_id and pool_type = p_pool_type
    for update;

  v_balance := v_balance + p_amount;
  update public.credit_pools
    set balance = v_balance,
        last_reset_at = case when p_action = 'monthly_grant' then now() else last_reset_at end,
        updated_at = now()
    where id = v_pool_id;

  insert into public.credit_transactions
    (customer_id, pool_type, delta, action, ref_id, balance_after, metadata)
    values (p_customer_id, p_pool_type, p_amount, p_action, p_ref_id, v_balance, p_metadata);

  return v_balance;
end;
$$;
grant execute on function public.grant_credits(uuid, text, numeric, text, text, jsonb) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- Set monthly_grant amounts for all 3 pools (called on subscription up/down).
-- Doesn't grant credits — just updates the recurring amount.
-- ──────────────────────────────────────────────────────────────────────────
create or replace function public.set_pool_grants(
  p_customer_id uuid,
  p_ai_tokens   numeric,
  p_video_units numeric,
  p_voice_min   numeric
)
returns void
language plpgsql
security definer
as $$
begin
  insert into public.credit_pools (customer_id, pool_type, balance, monthly_grant)
    values
      (p_customer_id, 'ai_tokens',     0, p_ai_tokens),
      (p_customer_id, 'video_units',   0, p_video_units),
      (p_customer_id, 'voice_minutes', 0, p_voice_min)
    on conflict (customer_id, pool_type) do update
      set monthly_grant = excluded.monthly_grant,
          updated_at = now();
end;
$$;
grant execute on function public.set_pool_grants(uuid, numeric, numeric, numeric) to service_role;

-- ──────────────────────────────────────────────────────────────────────────
-- updated_at trigger
-- ──────────────────────────────────────────────────────────────────────────
drop trigger if exists trg_touch_credit_pools on public.credit_pools;
create trigger trg_touch_credit_pools before update on public.credit_pools
  for each row execute function public.touch_updated_at();

-- ──────────────────────────────────────────────────────────────────────────
-- RLS: users can read their own pools + transactions; service role writes.
-- ──────────────────────────────────────────────────────────────────────────
alter table public.credit_pools         enable row level security;
alter table public.credit_transactions  enable row level security;

create policy credit_pools_select_self on public.credit_pools
  for select to authenticated
  using (
    exists (
      select 1 from public.billing_customers c
      where c.id = credit_pools.customer_id and c.user_id = auth.uid()
    )
  );

create policy credit_tx_select_self on public.credit_transactions
  for select to authenticated
  using (
    exists (
      select 1 from public.billing_customers c
      where c.id = credit_transactions.customer_id and c.user_id = auth.uid()
    )
  );
