-- ============================================================================
-- M2 hotfix: credit idempotency must include pool_type.
-- 0002 created a unique index and EXISTS check on (customer_id, action, ref_id)
-- which incorrectly blocked the second/third pool's initial grant when one pool
-- had already granted under the same subscription_id.
-- ============================================================================

-- Drop and recreate the idempotency index with pool_type.
drop index if exists public.credit_tx_idem;
create unique index credit_tx_idem
  on public.credit_transactions(customer_id, pool_type, action, ref_id)
  where ref_id is not null;

-- Update the EXISTS check inside grant_credits to also match on pool_type.
create or replace function public.grant_credits(
  p_customer_id uuid, p_pool_type text, p_amount numeric, p_action text,
  p_ref_id text, p_metadata jsonb default '{}'::jsonb
) returns numeric language plpgsql security definer as $$
declare v_pool_id uuid; v_balance numeric;
begin
  if p_amount <= 0 then return null; end if;
  if p_ref_id is not null and exists (
    select 1 from public.credit_transactions
    where customer_id = p_customer_id
      and pool_type   = p_pool_type
      and action      = p_action
      and ref_id      = p_ref_id
  ) then return null; end if;
  insert into public.credit_pools (customer_id, pool_type, balance)
    values (p_customer_id, p_pool_type, 0)
    on conflict (customer_id, pool_type) do nothing;
  select id, balance into v_pool_id, v_balance from public.credit_pools
    where customer_id = p_customer_id and pool_type = p_pool_type for update;
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
