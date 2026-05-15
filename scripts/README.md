# Scheduled content drafting

Drafts the next week's content for a brand, taking last 7 days of posts into account so the model varies angles instead of repeating.

## What it does

1. Reads the brand's playbook (in repo) + persona / voice / threads / visuals memory files (in ~/.claude).
2. Pulls the last 7 days of `content_scripts` rows for that brand from Supabase.
3. Calls Claude with all of the above and asks for next week's content list as a markdown table.
4. Writes the list to `~/Desktop/vtm-content-drafts/<brand>-week-<date>.md`.
5. Opens the file + shows a Mac notification.

Then the human (Ray) reviews, edits, and starts a normal Claude Code session that patches each approved post into the canvas.

## One-time install

### 1. Find your Node path

```bash
which node
```

Copy the output (e.g. `/opt/homebrew/bin/node` or `/usr/local/bin/node`).

### 2. Edit the launchd plist

Open `scripts/com.vtm.draft-next-week.plist` and replace:

- `<NODE_PATH>` → the path from step 1
- `<YOUR_USERNAME>` → your macOS short username (run `whoami` to see it)
- `<PASTE_ANTHROPIC_KEY>` → your Anthropic API key
- `<PASTE_SUPABASE_SERVICE_KEY>` → the Supabase service-role key (Settings → API in Supabase dashboard)

The Supabase URL is already filled in.

### 3. Install + load

```bash
cp scripts/com.vtm.draft-next-week.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.vtm.draft-next-week.plist
```

### 4. Test it once (don't wait until Friday)

```bash
launchctl start com.vtm.draft-next-week
```

You should see a Mac notification within ~30 seconds and a file appear on your Desktop. If anything went wrong, check `/tmp/vtm-draft-next-week.err`.

## Schedule

`StartCalendarInterval` is set to `Weekday=5` (Friday in launchd: Sun=0, Mon=1 … Fri=5, Sat=6), `Hour=5`, `Minute=0`. Adjust those three values in the plist if you want a different time.

## Adding another brand

Open `scripts/draft-next-week.mjs`, add a new entry to the `BRANDS` registry with the new client's `profile_id`, their playbook path, and their memory filenames. Then duplicate the plist with a new `Label` (e.g. `com.sanabreh.draft-next-week`) and change `--brand vtm` to `--brand sanabreh` in the args. Install the same way.

## Unloading / removing

```bash
launchctl unload ~/Library/LaunchAgents/com.vtm.draft-next-week.plist
rm ~/Library/LaunchAgents/com.vtm.draft-next-week.plist
```

## Why not just have it patch the canvas directly?

Because content review is the whole point. Auto-drafting saves the boring part (pulling last week, brainstorming the list); the human still reads, edits, and approves before anything lands as a real draft in ScaleSolo.
