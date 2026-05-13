-- Stream space_runs through Supabase Realtime so the canvas can
-- highlight each node as the Fly worker steps through a server-side
-- run. The client subscribes to a per-space channel and reads
-- node_progress on every UPDATE to flip nodes between idle / running
-- / done / failed. Without this publication entry the subscription
-- silently delivers nothing — same gotcha as credit_pools (see 0029).
alter publication supabase_realtime add table public.space_runs;
