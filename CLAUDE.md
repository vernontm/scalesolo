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

Ship straight to `main`. Do not open a pull request, and do not ask Ray to
review or merge one.

Any session that changes code in this repo finishes the job itself before
ending:
1. Make `npm run lint` and `npm run build` both pass. This is not optional now
   that nothing sits in a PR first: pushing to `main` deploys to production,
   where real clients publish, so a broken push is a broken product.
2. Commit the work.
3. Push it to `main`. From a worktree that cannot check `main` out, that is
   `git push origin HEAD:main`.
4. Fast-forward `feature/studio-v1` to the same commit, so Ray's preview URL
   stays current: `git push origin main:refs/heads/feature/studio-v1`.
5. Confirm the deploy actually landed before calling it done. Read the Vercel
   check on that commit, and where it is cheap, probe production itself rather
   than trusting the dashboard. A failed build does not take the site down,
   Vercel keeps serving the last good deployment, so a silent "nothing
   deployed" is the realistic failure and it has to be caught.

Never deploy with `vercel --prod` from a local checkout. It uploads the working
directory and bypasses git, which replaced production with a stale tree on
2026-10-19 and knocked out the employees' MCP access.

If you made no changes, say "no changes, nothing to ship" explicitly.

## Known context

- Posting gotchas are recorded in project memory (TikTok DIRECT_POST behavior, Facebook 255-char caption cap, and the post-once rule: never auto-retry a failed post, a retry loop double-posts or spams failures).
- The engineer agent's queue and log live in `docs/engineer/`.
