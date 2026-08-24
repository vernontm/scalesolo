-- Editor logins for the production board. Adds a least-privilege 'contributor'
-- role: it can use the board (upload versions, comment on its assigned cards)
-- but is deliberately excluded from the {owner,admin,editor} set that the
-- posting / scheduling / content / credit-spend endpoints require, and — by not
-- being listed in has_profile_access()'s editor/admin/owner arms — is denied
-- insert/update/delete on every profile-scoped table at the RLS layer.
alter table public.profile_access
  drop constraint profile_access_role_check,
  add constraint profile_access_role_check
    check (role in ('owner', 'admin', 'editor', 'viewer', 'contributor'));

-- The board filters a contributor's view to cards assigned to them.
create index if not exists board_cards_assigned_editor_idx
  on public.board_cards (assigned_editor);
