# Engineer queue

Tasks for the scheduled ScaleSolo engineer agent. One bullet per task, newest at the bottom. The agent works the TOP unchecked item each run, marks it `[PR]` with a link when a PR is open, and checks it off only after the PR merges.

Rules: no secrets or customer data in this file. The agent never implements business decisions (pricing, refunds, who gets access); those get a written question in LOG.md instead.

## Queue

- [ ] Orphaned branch audit: `claude/busy-davinci-b44f56` (Aug 5), `claude/beautiful-pascal-2ca126` (May), `feature/studio-v1` (Aug 5), and `marketing-pages` (Jun 1) all sit on origin with no PR. Diff each against main and report what it holds, whether it is already merged in substance, and a keep / open-PR / delete recommendation per branch. Report only; do not delete anything.
- [ ] TikTok photo-carousel posting is broken and retrying itself: 13 failed upload-post attempts Aug 2-6 ("5 AI Automations That Save You 10+ Hours a Week" alone failed 8 times over 3 days, including overnight retries). Two defects: (a) photo/carousel posts to TikTok fail while videos succeed, find the root cause in the posting pipeline (media type handling, TikTok photo API requirements, or payload shape) and fix it or route carousels away from TikTok cleanly; (b) something is auto-retrying failed posts for days, which violates the post-once rule, find and kill the retry loop. Read the upload-post error responses in the posting history for the actual failure reason before changing anything.
