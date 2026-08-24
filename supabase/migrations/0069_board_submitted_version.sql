-- Track which version was last submitted for review, so the "Submit for review"
-- button can be disabled until a NEW version is uploaded (no re-submitting the
-- same cut that was already reviewed). Set on submit; compared against the
-- newest version to decide whether there is anything new to review.
alter table public.board_cards
  add column if not exists submitted_version_id uuid
    references public.board_card_versions(id) on delete set null;
