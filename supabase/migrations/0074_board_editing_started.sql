-- Handoff signal: when the assigned editor picks up a card.
--
-- Stamped the first time the assigned editor opens a card that still needs
-- editing (and again when they pick up a fresh revision round). Surfaced as an
-- "In progress" badge on the board tile so the owner can see work has started
-- without asking. Nullable; no backfill needed.
alter table public.board_cards
  add column if not exists editing_started_at timestamptz;
