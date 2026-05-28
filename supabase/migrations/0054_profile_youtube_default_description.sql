-- Boilerplate description appended to every Studio video's YouTube
-- description after the auto-generated summary + chapter timestamps.
-- This is where the user puts their channel links, social handles,
-- affiliate disclosures, "subscribe for more" CTAs, etc. — the static
-- stuff that doesn't change per video.
--
-- The Schedule-to-YouTube flow builds the final description as:
--   <summary paragraph>
--   <empty line>
--   Chapters:
--   0:00 Intro
--   1:23 Topic A
--   ...
--   <empty line>
--   <youtube_description_default>
--
-- One default per brand profile. If a user has separate personal vs
-- business profiles, each gets its own boilerplate.

alter table public.profiles
  add column if not exists youtube_description_default text;

comment on column public.profiles.youtube_description_default is
  'Boilerplate appended to every Studio YouTube video description after the auto-generated summary + chapters. Channel links, socials, CTAs, etc.';
