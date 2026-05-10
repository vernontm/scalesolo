-- Curated ZapCap caption template catalog. We pull id + title from
-- ZapCap's /templates API on demand, but the preview asset shown to
-- users in the caption picker is driven by preview_gif_url which an
-- admin populates from Supabase Storage (no kid-talking-head demo
-- footage). active flips off templates we don't want surfaced.
create table if not exists public.zapcap_template_previews (
  template_id text primary key,
  title text not null,
  preview_gif_url text,
  sort_order int not null default 100,
  active boolean not null default true,
  last_synced_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists zapcap_template_previews_active_idx
  on public.zapcap_template_previews (active, sort_order, title);

alter table public.zapcap_template_previews enable row level security;
drop policy if exists zapcap_template_previews_read on public.zapcap_template_previews;
create policy zapcap_template_previews_read on public.zapcap_template_previews
  for select using (auth.role() = 'authenticated');
-- Mutations gated through admin-only API endpoints with the service role.
