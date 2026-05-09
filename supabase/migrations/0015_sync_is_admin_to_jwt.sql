-- Mirror user_profiles.is_admin into auth.users.raw_app_meta_data so the
-- flag is embedded in the JWT. requireAdmin (api/_lib/supabase.js) reads
-- the claim directly from the token, skipping a DB roundtrip per call.
--
-- Trigger fires only when is_admin actually changes; existing rows are
-- backfilled below. Users must sign in again after a grant/revoke for
-- the new claim to land in their token (or the SPA can refresh the
-- session — handled in AuthContext).

create or replace function public.sync_is_admin_to_app_metadata()
returns trigger
language plpgsql
security definer
set search_path = public, auth
as $$
begin
  if (TG_OP = 'INSERT') or (NEW.is_admin is distinct from OLD.is_admin) then
    update auth.users
    set raw_app_meta_data = coalesce(raw_app_meta_data, '{}'::jsonb)
                         || jsonb_build_object('is_admin', coalesce(NEW.is_admin, false))
    where id = NEW.id;
  end if;
  return NEW;
end
$$;

drop trigger if exists trg_sync_is_admin on public.user_profiles;
create trigger trg_sync_is_admin
  after insert or update of is_admin on public.user_profiles
  for each row execute function public.sync_is_admin_to_app_metadata();

update auth.users u
set raw_app_meta_data = coalesce(u.raw_app_meta_data, '{}'::jsonb)
                     || jsonb_build_object('is_admin', coalesce(up.is_admin, false))
from public.user_profiles up
where up.id = u.id;
