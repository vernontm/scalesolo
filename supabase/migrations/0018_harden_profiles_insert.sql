-- Pre-launch hardening. The original profiles_insert policy was
-- `with check (true)` — any authenticated user could INSERT arbitrary
-- profile rows directly via the supabase-js client (e.g. seeding garbage
-- logo_urls / brand_bibles, or pre-creating profiles to attach social
-- accounts to via /api/profiles?action=upsert path).
--
-- Profile creation flows through service-role API endpoints
-- (api/profiles.js, api/profiles/quickstart.js) which already enforce
-- the owner grant + RLS. The client-side INSERT path was unused and
-- is now removed.

drop policy if exists profiles_insert on public.profiles;
