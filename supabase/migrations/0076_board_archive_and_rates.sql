-- Production board: archive finished cards, and allow a per-card pay rate.
--
-- 1. archived_at. A card whose post actually published AND which owes nobody
--    money is done, so it leaves the board instead of piling up in Scheduled
--    forever. Nullable and never cleared automatically, so un-archiving is
--    just setting it back to null. Deliberately NOT a new stage value: stage
--    still means "where in production is this", archived means "finished".
--
-- 2. pay_rate. Editors are normally paid a derived flat rate
--    (editor_comp.monthly_amount / monthly_quota, e.g. 800/60 = 13.333333).
--    Some work is worth a different number, so a card may carry its own rate.
--    NULL means "use the editor's derived rate", which keeps every existing
--    card on exactly the behaviour it has today.
--
--    Note for whoever touches payouts next: earnings used to be count * rate.
--    With this column that is no longer true, and api/payouts.js now sums each
--    card's effective rate instead. Do not reintroduce the multiplication.

alter table public.board_cards
  add column if not exists archived_at timestamptz,
  add column if not exists pay_rate numeric;

-- A non-negative rate, but still allowing NULL to mean "inherit".
alter table public.board_cards
  drop constraint if exists board_cards_pay_rate_nonneg;
alter table public.board_cards
  add constraint board_cards_pay_rate_nonneg
  check (pay_rate is null or pay_rate >= 0);

-- The board lists live cards constantly and the archive rarely, so index the
-- live set (archived_at is null) rather than the whole table.
create index if not exists board_cards_live_idx
  on public.board_cards (profile_id, stage)
  where archived_at is null;

create index if not exists board_cards_archived_idx
  on public.board_cards (profile_id, archived_at desc)
  where archived_at is not null;
