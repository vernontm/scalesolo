-- Onboarding survey storage. The 6-question popup the dashboard shows
-- the very first time an authenticated user lands. Answers feed
-- personalization in the agent + email lifecycle.

alter table public.user_profiles
  add column if not exists onboarding_completed boolean not null default false,
  add column if not exists onboarding_data jsonb;
