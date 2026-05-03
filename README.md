# ScaleSolo

> The AI-native operating system for solopreneurs. **Scale your brand 10× faster.**

Independent codebase. Independent Supabase project. Independent Vercel project. ScaleSolo never imports from, queries, or otherwise depends on the Vernon Tech & Media (VTM) CRM.

## Status

Milestone 0 (skeleton). See [`SCALESOLO_PHASE_1_PLAN.md`](./SCALESOLO_PHASE_1_PLAN.md) for the milestone roadmap and [`SCALESOLO_AUDIT.md`](./SCALESOLO_AUDIT.md) for the architecture audit.

## Stack

- **Frontend:** React 18 + Vite, React Router 6, lucide-react, recharts, papaparse, dompurify
- **Styling:** CSS variables (light + dark themes via `[data-theme]`), Plus Jakarta Sans + DM Sans
- **Backend:** Vercel Serverless Functions (Node 20)
- **Database + Auth:** Supabase (Postgres 17 + Auth + Storage), strict RLS via `profile_access`
- **AI:** Anthropic Claude (LLM), ElevenLabs (voice + STT), HeyGen (avatar video), kie.ai / Nano Banana (image gen), OpenAI embeddings (M3)
- **Email:** Postmark (native, M4) and per-tenant MailerLite (existing)
- **Social:** UploadPost (multi-platform publish)
- **Payments:** Stripe (subscriptions + credit top-ups)

## Project layout

```
scalesolo/
├── api/                       # Vercel serverless functions
│   ├── _lib/supabase.js       # auth + REST helper (no VTM deps)
│   ├── health.js
│   ├── me.js
│   └── profiles.js
├── src/                       # React SPA
│   ├── components/            # Sidebar, Header, ThemeToggle, ...
│   ├── context/               # ThemeContext, AuthContext, ProfileContext
│   ├── lib/supabase.js        # client-side Supabase
│   ├── pages/                 # Login, Dashboard, Settings, Placeholder, ...
│   ├── styles/global.css      # design system (red gradient + light/dark)
│   ├── App.jsx
│   └── main.jsx
├── supabase/migrations/
│   └── 0000_baseline.sql      # all M0 tables + strict RLS
├── index.html
├── package.json
├── vercel.json
├── vite.config.js
└── .env.example
```

## Local dev

```sh
cp .env.example .env
# fill in VITE_SUPABASE_URL + VITE_SUPABASE_ANON_KEY (and SUPABASE_SERVICE_KEY for the API)
npm install
npm run dev          # http://localhost:5180
```

The app boots even without env vars; auth and DB calls will warn until configured.

## Apply the baseline migration

In the new ScaleSolo Supabase project:

```sh
# Either: paste contents of supabase/migrations/0000_baseline.sql into the SQL editor
# Or: use the Supabase CLI from this folder
supabase db push
```

## Theme system

- Default: dark.
- Toggle in Header (sun/moon icon) and Settings → Appearance.
- Persisted in `localStorage.scalesolo.theme`. Pre-applied in `index.html` to avoid flash.
- Add new tokens in `src/styles/global.css` under both `[data-theme="dark"]` and `[data-theme="light"]`.

## Architectural rule

> ScaleSolo never imports from VTM, never queries VTM's database, never calls VTM's API endpoints, never shares env vars or auth tokens.

If a VTM pattern is useful, copy and adapt it into ScaleSolo. Past Milestone 0, VTM doesn't exist.

## Roadmap (Phase 1 milestones)

| # | Goal |
|---|---|
| **M0** | Stand up ScaleSolo as its own app (this commit) |
| M1 | Brand polish + native Stripe billing live |
| M2 | Credit system (3 pools, top-ups, monthly grants) |
| M3 | AI CEO upgrades (pgvector memory, persistent conversations, behavior dial) |
| M4 | Native email sending via Postmark + deliverability dashboard |
| M5 | CRM expansion: pipeline kanban, forms builder, CSV import, activity timeline |
| M6 | Content engine polish + approval queue + ContentScheduler decomposition |
| M7 | Landing page builder |
| M8 | Polish + RLS hardening + AI CEO behavior settings + beta gate |
| M9 | Beta launch with founding members |

Full detail in [`SCALESOLO_PHASE_1_PLAN.md`](./SCALESOLO_PHASE_1_PLAN.md).
