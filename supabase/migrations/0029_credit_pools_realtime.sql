-- Make credit_pools changes flow through Supabase Realtime so the
-- dashboard's CreditsContext can subscribe and reflect deductions
-- (avatar render, video polish, etc.) and grants (initial trial,
-- topup, conversion) in the UI without polling or a page refresh.
--
-- RLS already filters per-user (credit_pools_select_self in 0002),
-- so adding to the publication only delivers rows the user is
-- allowed to read. No additional policy needed.
alter publication supabase_realtime add table public.credit_pools;
