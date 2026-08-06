# ScaleSolo

ScaleSolo (scalesolo.ai) is VTM's own social scheduling and posting product. Live production: real paying users, and VTM's client brands (rayvaughnceo, Sanabreh, Emanuel Motors, Fairouz) publish through it daily via upload-post. A silent breakage here means client posts silently stop, which has already happened once (the TikTok photo-carousel pipeline, Aug 2026).

Vite SPA in `src/`, serverless endpoints in `api/`, Supabase backend (`supabase/` with migrations, functions, email-templates), Playwright e2e in `tests/`, marketing site in `marketing/`.

## Hard rules

1. **Never publish, schedule, edit, or delete real social content from an engineering session.** No upload-post or ScaleSolo MCP write calls, no posting API calls with real tokens. Posting flows are tested with mocks or dry-run flags. One accidental live post goes to a client's audience.
2. **Databases are read-only in sessions.** Two Supabase projects: `vbvmfiepwyxlfafbwtkb` (scalesolo) and `kpjvncrumfedvlyaqukz` (scalesolo-marketplace). SELECT probes are fine. Schema changes are propose-only: write the migration into `supabase/migrations/` and list it in the PR for a human to apply.
3. **No Stripe writes.** Reads for debugging are fine.
4. **No secrets in code, commits, or PR bodies.** Customer emails and tokens never appear in engineering artifacts.
5. **No em dashes** anywhere: code comments, commits, PR bodies, UI copy.

## Verification bar

`npm run lint` and `npm run build` must both pass before shipping. Playwright e2e is optional in automated runs. Do not ship red.

## How sessions must finish

Any session that changes code in this repo finishes the job itself before ending:
1. Commit all work on a `claude/*` branch.
2. Push the branch explicitly (`git push -u origin claude/<slug>`).
3. Create the PR yourself with `gh pr create` and put the PR URL in your final reply.

Never end by pointing at a GitHub compare page or telling Ray to click a Create PR button. If you made no changes, say "no changes, nothing to ship" explicitly instead of offering a PR.

## Known context

- Posting gotchas are recorded in project memory (TikTok DIRECT_POST behavior, Facebook 255-char caption cap, and the post-once rule: never auto-retry a failed post, a retry loop double-posts or spams failures).
- The engineer agent's queue and log live in `docs/engineer/`.
