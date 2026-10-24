-- Brand linking fields for the VTM CRM integration.
--   contact_email : optional contact email on a brand. The CRM auto-links a
--                   brand to the client whose email matches exactly and
--                   unambiguously. Not unique on purpose (two brands may share
--                   an email; the CRM leaves those for a human).
--   external_ref  : an exact, opaque handle the CRM sets (e.g. "vtm:<client id>")
--                   so a link is exact rather than probabilistic. Unique when
--                   set, so one ref never points at two brands.
--
-- PROPOSE-ONLY: apply in the ScaleSolo Supabase project. Both columns are
-- nullable; the integration tolerates their absence until this is applied.

alter table public.profiles add column if not exists contact_email text;
alter table public.profiles add column if not exists external_ref  text;

create unique index if not exists profiles_external_ref_key
  on public.profiles (external_ref)
  where external_ref is not null;
