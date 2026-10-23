# Front-End Architecture and Design System

How the ScaleSolo SPA is structured (routing, providers, auth, multi-brand access, data flow)
and the design system that gives every page one consistent look. Written so the same patterns
can be reproduced in another app.

Reference files:
- `src/main.jsx` : provider stack + mount
- `src/App.jsx` : routing, the authenticated app shell
- `src/context/*` : Auth, Profile (brand), Theme, Credits, Agent, SpacesRun
- `src/components/Sidebar.jsx`, `src/components/Header.jsx` : chrome
- `src/lib/supabase.js` : the browser Supabase client
- `src/styles/global.css` : the design system (tokens + component classes)

---

## 1. Stack

- **Vite + React** single-page app in `src/` (plain JS/JSX, React Router, lazy-loaded routes).
- **Serverless API** in `api/` (Vercel functions) for anything privileged (posting, credits,
  admin, cron). The browser never holds service keys.
- **Supabase** for auth, Postgres (with RLS), and Realtime. The browser uses the **anon** key
  and reads through RLS; privileged writes go through `api/` with the service key.
- **State** lives in a small stack of React contexts, not Redux.

Mental model: the SPA reads data directly from Supabase (RLS-scoped) and calls `api/` endpoints
for actions. There is no separate REST client layer, components call `supabase` or `fetch('/api/...')`.

---

## 2. Provider stack (`src/main.jsx`)

Everything is wrapped in a fixed order. Theme is outermost (it only touches the DOM root), then
the router, then auth, then the brand/profile layer, then feature contexts.

```jsx
<ThemeProvider>
  <BrowserRouter>
    <AuthProvider>
      <ProfileProvider>
        <CreditsProvider>
          <AgentProvider>
            <SpacesRunProvider>
              <App />
            </SpacesRunProvider>
          </AgentProvider>
        </CreditsProvider>
      </ProfileProvider>
    </AuthProvider>
  </BrowserRouter>
</ThemeProvider>
```

Order matters: `ProfileProvider` depends on `useAuth()` (it loads the brands the signed-in user
can access), and `CreditsProvider` / feature contexts depend on the selected brand.

---

## 3. Routing and the app shell (`src/App.jsx`)

Two worlds split on auth state:

```jsx
export default function App() {
  const { session, loading } = useAuth()
  // ...public marketing routes (/, /pricing, /login, /f/:slug, /intake/:token, /faceless-brand)
  // when no session; otherwise the authenticated shell:
  return <Route path="/*" element={<AppShell />} />
}
```

`AppShell` is the authenticated chrome: a persistent `Sidebar`, a sticky `Header`, and a `main`
that renders the routed page inside `Suspense` (every page is `lazy()`-imported, so each route is
its own chunk):

```jsx
function AppShell() {
  return (
    <>
      <Sidebar compact={compact} />
      {/* mobile drawer variant: <Sidebar mobile onClose=... /> */}
      <Header onOpenSidebar={...} onToggleSidebar={toggleSidebar} sidebarCollapsed={compact} />
      <main className="app-content" style={WIDE_PAGES.some((p) => pathname.startsWith(p)) ? contentStyleWide : contentStyle}>
        <Suspense fallback={<RouteFallback />}>
          {/* <Routes> ... every page ... */}
        </Suspense>
      </main>
    </>
  )
}
```

The route table (abridged):

| Path | Page | Notes |
|---|---|---|
| `/dashboard` | `Dashboard` | default landing after login |
| `/schedule` | `Content` | the Schedule page (see docs/schedule-page.md) |
| `/schedule/queue` | `ApprovalQueue` | AI CEO approval queue |
| `/schedule/connections` | `Connections` | account connections |
| `/board` | `Board` | production board (see docs/production-board.md) |
| `/profiles` | `Profiles` | brand profiles (see docs/brand-profiles.md) |
| `/payouts` | `Payouts` | editor payouts |
| `/spaces`, `/studio` | `Spaces`, `/Studio` | node canvas + video studio (wide pages) |
| `/settings`, `/billing`, `/affiliate` | account | |
| `/admin/*` | `Admin` | admin-only |
| `/content` | redirect | 301 to `/schedule` |

`WIDE_PAGES` (Spaces, Studio) opt out of the normal max-width gutter so the canvas can go
full-bleed.

---

## 4. Auth (`src/context/AuthContext.jsx`)

Supabase Auth. `AuthProvider` exposes `{ session, user, loading }` via `useAuth()`. `App` gates
the whole shell on `session`: no session renders the public marketing routes, a session renders
`AppShell`. `loading` shows a splash so the app does not flash the login screen before the
session resolves.

---

## 5. Multi-brand access and RBAC (`src/context/ProfileContext.jsx`)

A user does not "own" one account, they have access to one or more **brand profiles**, each with
a **role** and a set of **allowed pages**. This is the multi-tenant core, it is what lets VTM
manage many client brands and invite editors to just one brand.

Access is read from a join table `profile_access (user_id, profile_id, role, allowed_pages)`:

```jsx
const { data } = await supabase
  .from('profile_access')
  .select('role, allowed_pages, profiles ( * )')
  .eq('user_id', user.id)
const list = (data || [])
  .map((row) => row.profiles ? { ...row.profiles, _role: row.role, _allowed_pages: row.allowed_pages } : null)
  .filter(Boolean)
```

The selected brand is kept in state and persisted to `localStorage` (`scalesolo.profile.selectedId`)
so it survives reloads, with a guard that always points at a real row:

```jsx
useEffect(() => {
  if (profiles.length === 0) return
  if (!selectedProfileId || !profiles.find((p) => p.id === selectedProfileId)) {
    setSelectedProfileIdState(profiles[0].id)   // auto-pick first accessible brand
  }
}, [profiles, selectedProfileId])
```

`useProfile()` exposes `{ profiles, selectedProfile, selectedProfileId, setSelectedProfileId, refresh }`.
Almost every page reads `selectedProfileId` and scopes its data to that brand. The brand switcher
in the sidebar (`ProfileSwitcher`) calls `setSelectedProfileId`.

**Page gating** uses `selectedProfile._allowed_pages`. The sidebar hides nav items a role cannot
see; `['*']` means all pages (owners), a list means a restricted role (for example a board editor
limited to `['board','payouts']`):

```jsx
const allowedPages = selectedProfile?._allowed_pages || ['*']
const pageKey = (to) => (to || '').split('/')[1] || ''
// item is shown when allowAll, or allowedPages.includes(pageKey(it.to))
```

A custom event `scalesolo:access-changed` triggers a `refresh()` so a just-claimed board invite
appears without a reload.

---

## 6. Theme (`src/context/ThemeContext.jsx`)

Dark-first, two themes, toggled by hand (never auto from the OS):

```jsx
// default dark unless localStorage says light; we intentionally do NOT read prefers-color-scheme
useEffect(() => { document.documentElement.dataset.theme = theme }, [theme])
```

`useTheme()` gives `{ theme, setTheme, toggleTheme }`. The theme is a single `data-theme` attribute
on `<html>`; all colors are CSS variables that flip under `[data-theme="light"]` (section 8). It is
pre-applied in `index.html` before React mounts so there is no flash of the wrong theme.

---

## 7. Data flow (reads, writes, realtime)

- **Reads**: components call the browser `supabase` client (`src/lib/supabase.js`, created with the
  anon key). RLS scopes rows to the user and their accessible brands.
- **Writes / privileged**: components `fetch('/api/...')`. Those functions use the service key and
  enforce access with `requireUser` + `assertProfileAccess`.
- **Realtime**: the server writes an in-app notification row (`notify()` in `api/_lib/notify.js`)
  to a `notifications` table that is in the `supabase_realtime` publication. The SPA subscribes over
  its open Realtime channel and the bell updates instantly. `CreditsContext` uses the same Realtime
  mechanism to live-update the credit balance. This is also the `post.published` / `post.scheduled`
  signal the Schedule page and the post-caption watchdog consume.

---

## 8. Design system (`src/styles/global.css`)

One stylesheet defines the whole look as CSS variables, so every page and component composes from
the same tokens and both themes stay consistent.

### Tokens

```css
:root {
  /* brand, same in both modes */
  --red: #ef4444;  --red-dark: #b91c1c;  --red-soft: rgba(239,68,68,0.12);
  --green: #2ecc71;  --amber: #f59e0b;      /* semantic success / warning */

  --font-display: 'Plus Jakarta Sans', system-ui, sans-serif;   /* headings, buttons, labels */
  --font-body:    'DM Sans', system-ui, sans-serif;             /* body text */

  --r-sm: 8px; --r-md: 10px; --r-lg: 16px; --r-pill: 999px;     /* radii */
  --ease: cubic-bezier(0.22, 1, 0.36, 1);                       /* one motion curve */

  /* mobile scale: spacing --sp-1..8, type --t-title/h2/row/body/meta/label, touch --tap/--fab */
}
```

Theme-dependent surfaces are redefined per theme (dark is the default on bare `:root`, light under
`[data-theme="light"]`):

```css
:root, [data-theme="dark"] {
  --bg: #111112; --surface: #1a1a1c; --surface-2: #222226; --surface-3: #2a2a30;
  --border: rgba(255,255,255,0.07); --text: #f0f0f0; --text-soft: #cccccd; --muted: #9a9aa3;
  --shadow-card: 0 12px 32px rgba(0,0,0,0.35);
  color-scheme: dark;
}
[data-theme="light"] {
  --bg: #f7f6f4; --surface: #ffffff; --surface-2: #f3f1ee; --surface-3: #ebe8e3;
  --border: rgba(17,17,17,0.08); --text: #18181a; --text-soft: #3f3f46; --muted: #6b6b72;
  color-scheme: light;
}
```

Note the `--muted` / `--text-soft` values were tuned to pass WCAG AA on dark surfaces. Semantic
color (green success, amber warning, red danger) is separate from the red brand accent.

### Signature backdrop

A fixed, non-interactive radial-gradient wash in brand red sits behind everything (`body::before`,
`z-index: 0`; `#root` sits at `z-index: 1`). It is what gives every screen the subtle red glow.

### Component classes

The stylesheet ships ready-made classes so pages rarely write raw button/card/input CSS:

- Buttons: `.btn-primary` (red gradient), `.btn-secondary`, `.btn-ghost`
- Containers: `.card` (hover-lift), `.card-flat`
- Forms: `.input`, `.textarea`, `.select`, `.label` (all with a red focus ring)
- Status: `.pill` + `.pill-success|warning|danger|muted`
- Utility: `.muted`, `.soft`, `.brand-text` (red gradient text), `.divider`, `.spinner`

```css
.btn-primary { background: linear-gradient(135deg, var(--red), var(--red-dark)); color:#fff;
  border-radius: var(--r-md); box-shadow: 0 6px 20px rgba(239,68,68,0.25); }
.card { background: var(--surface); border: 1px solid var(--border); border-radius: var(--r-lg); }
.pill-success { background: var(--green-soft); color: var(--green); }
```

### Accessibility and motion

- A universal `:focus-visible` red outline makes keyboard nav visible on every interactive element.
- `@media (prefers-reduced-motion: reduce)` neutralizes animations app-wide.

### Responsive

- The sidebar is fixed on desktop and collapses to a slide-in drawer below 900px (`.desktop-sidebar`
  hides, a hamburger in the Header opens `.mobile-sidebar`).
- Utility classes `.hide-on-mobile`, `.hide-on-narrow`, `.hide-on-tablet`, `.mobile-only` gate
  content by breakpoint. Pages also carry their own mobile overrides keyed off stable class names.

---

## 9. Navigation (`src/components/Sidebar.jsx`)

The sidebar is the app map. Items are grouped into sections, each item is `{ to, label, icon, beta?, adminAlways? }`, filtered by the selected brand's `allowed_pages` (and an Admin section only for
`is_admin` users). The brand switcher (`ProfileSwitcher`) sits at the top.

| Section | Items |
|---|---|
| Workspace | Dashboard, AI CEO (`/agent`) |
| Create | Create, Spaces, Schedule, Board, Payouts, Avatars, Library, Email, Landing |
| Grow | Contacts, Pipeline, Analytics |
| Account | Brand profiles (`/profiles`), Billing, Affiliate, Settings |
| Admin (admins only) | Admin home, Space templates, ... |

`beta` items show a small badge; `adminAlways` keeps an item visible to admins even when a brand's
`allowed_pages` would hide it.

---

## 10. Porting the pattern

1. Vite + React, React Router with `lazy()` routes under one authenticated shell (sidebar + header + `Suspense` main).
2. A fixed provider stack: Theme > Router > Auth > Brand/Profile > feature contexts.
3. Multi-brand access through a `profile_access` join table carrying `role` + `allowed_pages`; keep the selected brand in context + `localStorage`; gate nav by `allowed_pages`.
4. Read through Supabase (anon key + RLS) in the browser; do privileged writes in serverless functions with the service key; push live updates through a `notifications` table on Realtime.
5. One `global.css` token system: brand + semantic colors, two font roles, a radii/spacing scale, one easing curve, dark-first with a `[data-theme="light"]` flip, and a set of `.btn/.card/.input/.pill` component classes every page reuses.
