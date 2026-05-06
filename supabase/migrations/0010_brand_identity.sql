-- 0010_brand_identity.sql
-- Structured brand identity fields used by the Spaces brand_profile node
-- and image generators. logo_url already exists; we add colors + fonts as
-- editable JSONB arrays. brand_bible stays as the long-form catch-all.

alter table profiles
  add column if not exists brand_colors jsonb not null default '[]'::jsonb,
  add column if not exists brand_fonts  jsonb not null default '[]'::jsonb;

-- Optional: a quick parsed summary of the bible (for downstream prompt
-- assembly without having to re-distill on every generation).
alter table profiles
  add column if not exists brand_bible_summary text;

comment on column profiles.brand_colors is 'Array of {name, hex} entries used by image_gen when "theme" is selected on brand_profile.';
comment on column profiles.brand_fonts  is 'Array of {name, usage} entries (display, body, mono).';
