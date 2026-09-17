# ScaleSolo Post-Caption Watchdog

A small watchdog that runs **on your Mac** and makes sure every client post that
goes live actually has a real caption and hashtags, not a leftover like
`[outro jingle]`. If something is wrong it sends an **iMessage** starting with
`URGENT:`.

It reads the `post.published` signal your app already writes to Supabase the
moment a post goes out, so it needs **no changes to the posting pipeline** and
cannot affect real posts. It only reads data and sends you a text.

## How it works

1. Every ~60s it reads new `post.published` notifications from Supabase
   (each carries the live `post_url`, platform, and brand).
2. It scrapes that exact live post via Apify (TikTok, Instagram, YouTube) to
   read the **real** caption that published.
3. It flags a post when the caption is **empty**, is just a placeholder tag
   like `[outro jingle]` / `(on-hold music)`, has no readable text, or has
   **no hashtags**.
4. On a flag it iMessages your alert number:
   `URGENT: <brand> <platform> post has a caption problem: <reasons>. <url>`

A brand-new post is often not scrapeable for a few minutes. The watchdog
**retries quietly** for `RETRY_WINDOW_MIN` and only ever texts you on a
*confirmed* problem, never on "not indexed yet."

## Requirements

- Node 18+ (`node --version`)
- macOS **Messages** app signed in to iMessage. For a plain cell number that is
  not on iMessage, enable **Text Message Forwarding** on your paired iPhone
  (Settings > Messages > Text Message Forwarding).
- A Supabase **service-role key** for the ScaleSolo project (read-only use here).
- An **Apify** API token.

## Setup

```bash
cd watchdog
cp .env.example .env
# edit .env and fill in SUPABASE_SERVICE_KEY, APIFY_TOKEN, ALERT_IMESSAGE_TO
```

Test the pieces before enabling:

```bash
# 1. Caption logic only (offline, no keys needed):
node watch.mjs --check "[outro jingle]"      # -> ok:false
node watch.mjs --check "Best tacos in Katy #katytx #foodie"  # -> ok:true

# 2. Confirm iMessage works (sends one text to ALERT_IMESSAGE_TO):
npm run test-message

# 3. One real cycle without sending texts (prints what it WOULD send):
npm run dry-run
```

## Run it automatically (launchd, every 60s)

```bash
which node          # note this path
pwd                 # note the absolute path to this watchdog folder

# edit com.vernontm.scalesolo-watchdog.plist: replace __NODE__ and __DIR__
cp com.vernontm.scalesolo-watchdog.plist ~/Library/LaunchAgents/
launchctl load -w ~/Library/LaunchAgents/com.vernontm.scalesolo-watchdog.plist
```

Watch it work: `tail -f watchdog.log`

Stop it:

```bash
launchctl unload -w ~/Library/LaunchAgents/com.vernontm.scalesolo-watchdog.plist
```

The Mac must be awake and signed in for iMessage to send. If the Mac is asleep,
checks resume when it wakes (unsent posts are retried within the retry window).

## Timing, honestly

- **Post Now** posts: detected within a cycle or two (~1-3 min), then scraped.
- **Scheduled** posts: the "went live" signal comes from the app's 10-minute
  `sync-scheduled-posts` cron, so detection can be a few minutes behind, plus
  scrape indexing time. Realistic alert latency is "a few minutes," not always
  1-2. This is a platform/indexing limit, not a bug.

## Cost

Apify charges per scrape (~$0.005-$0.01 per post depending on actor tier). One
scrape per published post (plus a retry or two if indexing is slow). At normal
posting volume this is a few cents a day.

## Limitations / notes

- One caption is shared across all platforms of a post, so checking the one
  live URL in the notification is enough to catch a bad caption.
- Covered platforms: TikTok, Instagram, YouTube. Others are skipped (their
  scrapers are unreliable). Change `PLATFORMS` in `.env` to adjust.
- Apify actor slugs/fields occasionally change; if scrapes stop returning
  captions, adjust `ACTORS` in `lib/apify.mjs` (one file).
- Secrets live only in `.env` (gitignored). Never commit real keys or numbers.

## Files

- `watch.mjs` main one-shot cycle
- `lib/caption.mjs` the good-vs-junk caption rules
- `lib/apify.mjs` per-platform live scrapers
- `lib/supabase.mjs` reads the `post.published` feed
- `lib/imessage.mjs` sends the alert via osascript
- `lib/config.mjs` env + state
