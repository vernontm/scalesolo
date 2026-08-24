-- Show the assigned editor on the card face (Notion-style), by their NAME.
-- board_invites.name captures the name an admin types with the email at invite
-- time; it's set on the editor's account when they claim, and denormalized onto
-- the card at assign time so the board renders "who" without resolving auth.users.
alter table public.board_cards
  add column if not exists assigned_editor_email text,
  add column if not exists assigned_editor_name text;

alter table public.board_invites
  add column if not exists name text;
