# ScaleSolo system docs

Code-level reference for the parts of ScaleSolo that make up the posting product, written so the
same system can be rebuilt in another app. Each doc quotes real files and identifiers.

Read in this order:

1. **[frontend-architecture-and-design.md](frontend-architecture-and-design.md)** : the SPA shell,
   provider stack, auth, the multi-brand access model (RBAC), theming, data flow, and the whole
   design-token system. Start here for the overall shape.
2. **[brand-profiles.md](brand-profiles.md)** : the brand profile (the `profiles` table, the editor,
   the brand bible + auto-learned voice). The brand is the multi-tenant unit everything is scoped to.
3. **[production-board.md](production-board.md)** : the Kanban where editors upload cuts and owners
   approve; approving spawns a draft on the Schedule page.
4. **[schedule-page.md](schedule-page.md)** : the `/schedule` page (tabs, the social-accounts panel,
   the bulk-upload table, the per-post editor, the calendar). The surface that finishes and schedules posts.
5. **[upload-post-scheduling-system.md](upload-post-scheduling-system.md)** : the posting engine,
   connecting client accounts (the connect link), building and sending a post to Upload-Post,
   scheduling, status reconcile, and platform gotchas. The portable core.

The flow across them: a **brand** (2) connects its socials (5) -> an editor delivers a cut on the
**board** (3) -> approval drops it on the **Schedule page** (4) -> the Schedule page finishes it and
hands it to the **posting engine** (5), all inside the **app shell** (1).
