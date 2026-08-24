-- Board activity feed. Two additions:
--   1. Feedback can target a specific version (target_version_id) or reply to a
--      specific comment (parent_comment_id), so the thread reads like the Notion
--      card: uploads and comments interleaved, with replies attached to an item.
--   2. Denormalize the author's display name + avatar (from the signed-in user's
--      metadata) onto versions and comments, so the activity thread renders real
--      identities without joining across to auth.users (which PostgREST can't
--      embed from the public schema).

alter table public.board_card_comments
  add column if not exists target_version_id uuid references public.board_card_versions(id) on delete cascade,
  add column if not exists parent_comment_id uuid references public.board_card_comments(id) on delete cascade,
  add column if not exists author_name text,
  add column if not exists author_avatar text;

alter table public.board_card_versions
  add column if not exists author_name text,
  add column if not exists author_avatar text;

create index if not exists board_card_comments_target_idx
  on public.board_card_comments (target_version_id);
create index if not exists board_card_comments_parent_idx
  on public.board_card_comments (parent_comment_id);
