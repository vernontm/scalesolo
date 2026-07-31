# TikTok Draft → iMessage texter

RayvaughnCEO posts TikTok in **Draft mode** — at the scheduled time the post
lands in your TikTok inbox/drafts and you publish it natively from the app
(better organic reach). TikTok **drops the caption/hashtags** in Draft mode, so
this little agent texts them to you the moment a draft goes live, ready to paste.

Runs on your Mac via `launchd`, every 5 minutes. It only fires while your Mac is
awake and online (that's the trade-off for using real iMessage).

## Setup (one time)

1. **Create the config** `texter.env` in this folder (it is git-ignored):

   ```
   SCALESOLO_INTERNAL_SECRET=<the same secret the ScaleSolo MCP uses>
   SCALESOLO_USER_ID=<your ScaleSolo auth user id>
   SCALESOLO_PROFILE_ID=736be41b-f9d2-4b25-a7fb-dbad86670e77   # RayvaughnCEO / VTM
   IMESSAGE_TO=+1XXXXXXXXXX                                     # your phone or Apple ID email
   # optional:
   # WINDOW_MIN=45          # how far back (minutes) to catch a go-live you missed
   # SCALESOLO_API_BASE=https://www.scalesolo.ai
   ```

2. **Test it by hand** (this may pop a one-time macOS prompt to let the script
   control Messages — click OK):

   ```bash
   node tools/tiktok-texter/texter.mjs
   ```

   Look for `nothing due` (or a `texted …` line) and check /tmp log if needed.

3. **Install the timer.** Find your node path, fill the two placeholders in the
   plist, copy it into LaunchAgents, and load it:

   ```bash
   which node   # e.g. /usr/local/bin/node or /opt/homebrew/bin/node
   ```

   Edit `com.scalesolo.tiktok-texter.plist` → replace `__NODE_PATH__` with that
   path and `__TEXTER_MJS_PATH__` with the absolute path to `texter.mjs`, then:

   ```bash
   cp tools/tiktok-texter/com.scalesolo.tiktok-texter.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.scalesolo.tiktok-texter.plist
   ```

## How it decides what to text

Every run it pulls the brand's calendar posts and texts any **TikTok** post whose
`scheduled_datetime` is within the last `WINDOW_MIN` minutes and hasn't been
texted before (dedup state in `~/.scalesolo/tiktok-texter-sent.json`).

## Controls

- **Logs:** `tail -f /tmp/scalesolo-tiktok-texter.log`
- **Pause:** `launchctl unload ~/Library/LaunchAgents/com.scalesolo.tiktok-texter.plist`
- **Resume:** `launchctl load ~/Library/LaunchAgents/com.scalesolo.tiktok-texter.plist`
- **Missed one while the Mac was asleep?** Raise `WINDOW_MIN` so a later run
  still catches it, or just run `node texter.mjs` once by hand.

## Notes

- The impersonation secret in `texter.env` is user-owned and stays local — it is
  git-ignored and never committed.
- This texts you the copy; it does not post anything. You publish from the TikTok
  app, which is the whole point of Draft mode.
