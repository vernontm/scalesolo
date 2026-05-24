-- Studio template + brand-color overrides on studio_videos.
--
-- template_id: slug of the visual preset the user picked when they
-- started the video (e.g. "sleek", "casey-calm", "hormozi-bold").
-- We keep this as text (not FK) because templates live as JS constants
-- in api/studio/_lib/templates.js — easier to iterate the spec without
-- a migration every time. The generate-map + render-final pipelines
-- look up the template by id when they need to.
--
-- brand_color: user's primary accent color. Cascades into the
-- compositions' --accent CSS variable, the B-roll prompt's color
-- guidance, and Studio's UI. Stored as a hex string like "#e3151e".
-- Null falls through to the template's default accent.

alter table public.studio_videos
  add column if not exists template_id text default 'sleek',
  add column if not exists brand_color text;

create index if not exists studio_videos_template_idx on public.studio_videos (template_id);
