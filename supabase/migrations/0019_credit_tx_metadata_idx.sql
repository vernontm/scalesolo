-- Refund-by-metadata path (api/_lib/credits.js refundConsumeByMetadata)
-- queries credit_transactions filtered by action + a metadata key:
--   taskId            for consume:image-gen failures
--   heygen_video_id   for consume:photo-avatar-render failures
-- Without these expression indexes the planner does a heap scan of
-- every consumption row, which grows linearly with usage. Partial
-- indexes (the only consume actions we refund-by-metadata today)
-- keep them tiny.

create index if not exists credit_tx_meta_taskid_idx
  on public.credit_transactions ((metadata->>'taskId'))
  where action = 'consume:image-gen';

create index if not exists credit_tx_meta_heygen_video_id_idx
  on public.credit_transactions ((metadata->>'heygen_video_id'))
  where action = 'consume:photo-avatar-render';
