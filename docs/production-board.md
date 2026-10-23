# Production Board

A native Kanban that replaces a Notion approval flow for video production. One unified board
across every brand the user can access; each card is tagged to a client brand (`profile_id`).
This is the stage between "editor has footage" and "it lands on the Schedule page."

Reference files:
- `src/pages/Board.jsx` : the board UI
- `api/board.js` : cards, move/approve, send-to-schedule
- `api/board/versions.js`, `api/board/comments.js`, `api/board/invites.js` : uploads, activity, editors
- `supabase/migrations/0067_production_board.sql` (+ 0068 to 0076) : schema

---

## 1. Workflow

An owner/admin invites editors by email. Each editor logs in (passwordless magic link) and sees
**only the cards assigned to them**, across the brands they were granted. An editor uploads cuts
(video versions) to a card, exchanges feedback in one chronological activity thread, and submits
for review. The owner/admin approves. **Approving (or "Send to Schedule") spawns a `content_scripts`
draft** that flows into the existing Schedule page and scheduler. There is deliberately no posting
code in the board, it hands off to the scheduling system (see `docs/upload-post-scheduling-system.md`).

```
invite editor → editor uploads cut → submit for review → owner approves
   → Send to Schedule spawns a content_scripts draft (status 'draft', generated_by 'board')
   → caption generation kicks off → the post lives on the Schedule page from here
```

Media uploads go straight from the browser to the `landing-media` Supabase storage bucket via XHR
(with a progress bar), pathed `<profile_id>/board/<card_id>/<ts>-<rand>.<ext>` so storage RLS passes.

---

## 2. Data model

### `board_cards` (0067, extended by 0069/0072/0074/0076)

| column | purpose |
|---|---|
| `id` uuid PK | |
| `profile_id` uuid NOT NULL -> profiles(id) | the client/brand |
| `title` text (default 'Untitled') | |
| `stage` text NOT NULL default 'raw' | CHECK in `('raw','editing','in_review','needs_revisions','approved','scheduled')` |
| `position` double precision | ordering within a column |
| `assigned_editor` uuid -> auth.users(id) | the editor (null before claim) |
| `assigned_editor_email`, `assigned_editor_name` text | denormalized assignee for the card face (0072) |
| `final_version_id` uuid -> board_card_versions(id) | the cut that ships |
| `submitted_version_id` uuid -> board_card_versions(id) | last version submitted for review (0069) |
| `content_script_id` uuid -> content_scripts(id) | set on Send to Schedule |
| `approved_at` timestamptz | stamped once, the first time it reaches approved/scheduled; drives payability |
| `payout_id` | links to `editor_payouts` when paid |
| `pay_rate` numeric | per-card rate override; NULL means use the editor's derived rate (0076) |
| `archived_at` timestamptz | finished-and-paid cards leave the board (not a stage) (0076) |
| `editing_started_at` timestamptz | "in progress" handoff signal (0074) |
| `source_note`, `created_by`, `created_at`, `updated_at` | |

Related tables:
- **`board_card_versions`** : `card_id`, `profile_id` (denormalized for RLS), `version_no`, `video_url`, `thumbnail_url`, `kind` (`'raw'|'edit'`), `note`, `uploaded_by`, `author_name`/`author_avatar` (0068).
- **`board_card_comments`** : `card_id`, `profile_id`, `author_id`, `body`, `target_version_id` (feedback on a specific file), `parent_comment_id` (threaded reply), `author_name`/`author_avatar` (0068).
- **`board_invites`** (0071) : `email` (lowercased), `profile_id`, `role` (default `'contributor'`), `status` (`'pending'|'accepted'|'revoked'`), `invited_by`, `name`, `unique (email, profile_id)`.
- **`editor_payouts`** (read by the board to show "Paid $X USDT" + a Solscan tx link).

RLS on every board table mirrors `profile_access` via `public.has_profile_access(profile_id)`. The
API itself uses the service key and enforces access in code.

---

## 3. Stages and transitions

Five UI columns (`src/pages/Board.jsx`), one legacy DB value `raw` folded into `editing`:

| key | label | color |
|---|---|---|
| `editing` | Needs Editing | #60a5fa |
| `in_review` | Ready for Review | #a78bfa |
| `needs_revisions` | Needs Revisions | #f59e0b |
| `approved` | Approved | #2ecc71 |
| `scheduled` | Scheduled | #ef4444 |

```js
// src/pages/Board.jsx
const STAGES = [
  { key: 'editing',         label: 'Needs Editing',    color: '#60a5fa' },
  { key: 'in_review',       label: 'Ready for Review', color: '#a78bfa' },
  { key: 'needs_revisions', label: 'Needs Revisions',  color: '#f59e0b' },
  { key: 'approved',        label: 'Approved',         color: '#2ecc71' },
  { key: 'scheduled',       label: 'Scheduled',        color: '#ef4444' },
]
// api/board.js backend whitelist:
const STAGES = ['raw', 'editing', 'in_review', 'needs_revisions', 'approved', 'scheduled']
```

How a card moves:
- **Drag/drop (desktop)**: dnd-kit; `onDragEnd` POSTs `/api/board?id=...&action=move` with `{ stage, position }`. Mobile uses a segmented stage picker + the card sheet buttons (no drag).
- **Drawer buttons**: Submit for review (`in_review` + sets `submitted_version_id`), Approve, Request revisions (`needs_revisions`), Send to Schedule.
- **Auto-move on upload**: when a contributor uploads an `edit` to a card in `raw/editing/needs_revisions`, `api/board/versions.js` auto-sets `in_review` + `submitted_version_id` (editors kept forgetting to click Submit).

Guardrails (`stageChangeError` in `api/board.js`): only owner/admin may move a card **into** approved
or scheduled (editors cannot self-approve); only a manager may pull a **paid** card back out.

```js
// api/board.js
function stageChangeError(card, targetStage, role) {
  if (!targetStage || targetStage === card.stage) return null
  const isManager = ['owner', 'admin'].includes(role)
  if (APPROVED_STAGES.has(targetStage) && !isManager) {
    return 'Only an owner or admin can approve or schedule a card.'
  }
  // ... plus: cannot drag a paid card out of approved/scheduled unless manager
}
```

`approved_at` is stamped exactly once, the first time a card reaches approved or scheduled. It is
set in all three transition paths, always guarded by `!rows[0].approved_at`:

```js
// api/board.js (PATCH path; same pattern on action=move and send-to-schedule)
// Payable once done: stamp approved_at the first time it's approved or scheduled.
if (APPROVED_STAGES.has(updates.stage) && !rows[0].approved_at) updates.approved_at = new Date().toISOString()
```

---

## 4. Send to Schedule (the handoff)

`?action=send-to-schedule` (owner/admin only, idempotent) resolves the final cut
(`final_version_id` else newest version), resolves publish platforms from the brand's
`default_platforms` / `uploadpost_platforms`, inserts a **`content_scripts` draft**, and marks the
card scheduled:

```js
// api/board.js
const created = await supaFetch('content_scripts', {
  method: 'POST',
  body: {
    profile_id: cardRow.profile_id,
    title: (cardRow.title || 'Untitled').slice(0, 200),
    media_urls: [finalV.video_url],
    media_type: 'video', post_type: 'video',
    status: 'draft', generated_by: 'board',
    ...(draftPlatforms.length ? { platforms: draftPlatforms } : {}),
  },
})
const draft = Array.isArray(created) ? created[0] : created
await supaFetch(`board_cards?id=eq.${id}`, {
  method: 'PATCH',
  body: {
    content_script_id: draft.id, stage: 'scheduled', updated_at: new Date().toISOString(),
    ...(cardRow.approved_at ? {} : { approved_at: new Date().toISOString() }),
  },
})
```

The UI's one-click Approve calls `runSendToSchedule` for you, then kicks off caption generation on
the new draft via `/api/content/bulk-actions?action=generate-captions`:

```js
// src/pages/Board.jsx
const approve = async () => {
  if (!latestVersionId) { toast({ message: 'Upload a video before approving.', kind: 'warn' }); return }
  await patchCard({ stage: 'approved', final_version_id: latestVersionId })
  if (!card.content_script_id) await runSendToSchedule()
  onChanged(); onClose()
}
```

Reverse direction: a card leaving approved/scheduled calls `holdScheduledPost`, which invokes the
content handler `action=unschedule` so the old cut cannot publish while it is reworked. A brand
change cascades `profile_id` onto versions/comments and moves the post via `action=move-brand`.

Auto-archive: on each board GET, a card that `isFinished` (its post is `posted` and nothing is owed,
or `payout_id` is set) is archived self-healingly, so finished-and-paid work leaves the live board.

---

## 5. Board.jsx structure

Components: `Board` (page), `StageColumn` (droppable), `SortableCard` + `CardBody` (tile, reused by
the drag overlay), `NewCardModal`, `CardDrawer` (the card detail: client/editor/pay-rate pickers,
upload with progress, one merged Activity thread of versions + comments, composer, action buttons,
payment record), `EditorsModal` (invite/grant/revoke), `SetPasswordPrompt` (first-login password
offer for magic-link editors), `BrandSelect`, `Avatar`.

Key state in `Board()`: `cards`, `loading`, `activeDragId`, `openCardId`, filter state
(`fBrand`/`fEditor`/`fPost`), `showArchive`, `unpaidOnly`, `isAnyManager`, mobile `mobileStage`.
Derived: `byStage` (cards grouped + sorted per column). Data loads from `GET /api/board`
(`?archived=1` for the archive view). `CardDrawer` holds `versions`, `comments`, `uploadPct`,
`rateDraft`, and a `useMemo` that merges versions + comments into one newest-first activity feed.

---

## 6. Editor access (contributor role)

Access is a `profile_access` row with `role='contributor'` and `allowed_pages=['board']` (the API
uses `ALLOWED_PAGES = ['board', 'payouts']`). `contributor` was added to `profile_access`'s role
CHECK (0070) as a least-privilege role deliberately excluded from `has_profile_access()`'s
editor/admin/owner arms, so it has no insert/update/delete at the RLS layer; all its writes go
through the service-key API, which re-checks.

Invite/claim flow (`api/board/invites.js`): an owner/admin POSTs `{ email, name, profile_ids[] }`;
`grantBrand` upserts a `board_invites` row (`status='accepted'` if the email already has an account,
else `'pending'`) and, for existing users, immediately upserts the contributor `profile_access` row.
A magic link is generated via GoTrue admin (`generate_link`, type `invite` for new users or
`magiclink` for existing) and emailed. When a pending editor first signs in, the invite is claimed
into a `profile_access` row.

```js
// api/board/invites.js
if (req.method === 'POST') {
  const email = String(req.body?.email || '').trim().toLowerCase()
  const profileIds = (req.body?.profile_ids || []).filter(isUuid)
  for (const pid of profileIds) await assertMinRole(auth.user.id, pid, 'admin')
  const user = await findUserByEmail(email)
  for (const pid of profileIds) await grantBrand(email, pid, auth.user.id, user, name)
  const link = await loginLink(email, !user)
  await sendInviteEmail(email, link, brands.map((b) => b.business_name))
  return res.status(200).json({ ok: true, pending: !user })
}
```

Gating specifics: on the board GET, a contributor is restricted to `assigned_editor=eq.<their user_id>`,
and `pay_rate` is stripped from the response for any brand where the user is not owner/admin, so an
editor can never learn what a card pays. `?action=brand_editors&profile_id=` feeds the card assignee
picker (including invited-but-not-yet-accepted editors).

---

## 7. Payout note

Earnings used to be `count * rate`. With per-card `pay_rate` (0076), `api/payouts.js` sums each
card's effective rate instead; do not reintroduce the multiplication. `approved_at` is the payable
signal (set once, never cleared), and `payout_id` marks a card paid.
