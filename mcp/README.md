# ScaleSolo MCP

Drive ScaleSolo's posting pipeline for any of your brands from an MCP client
(Claude): **upload a video/image → auto-caption → pick a time slot → review →
schedule**. Nothing is posted automatically — only `schedule_post` reaches
Upload-Post, and it's meant to run only after you confirm.

## Setup

```bash
cd mcp
npm install
```

Get the internal secret (same value as Vercel's `WORKFLOW_INTERNAL_SECRET`) from
the linked ScaleSolo repo:

```bash
# from the ScaleSolo project root (linked to Vercel)
vercel env pull .env.vercel      # writes WORKFLOW_INTERNAL_SECRET=... (gitignored)
```

## Claude config

Add to your Claude Code MCP config (`~/.claude.json` `mcpServers`, or via
`claude mcp add`). Fill the secret from the value you pulled above — do NOT
commit it.

```json
{
  "mcpServers": {
    "scalesolo": {
      "command": "node",
      "args": ["/absolute/path/to/Scalesolo/mcp/server.js"],
      "env": {
        "SCALESOLO_API_BASE": "https://scalesolo.ai",
        "SCALESOLO_INTERNAL_SECRET": "<WORKFLOW_INTERNAL_SECRET>",
        "SCALESOLO_USER_ID": "84df3249-68f9-48f6-83f1-1c0e16d63cea"
      }
    }
  }
}
```

`SCALESOLO_USER_ID` is the ScaleSolo auth user to act as (defaults above are
Ray / ray@vernontm.com, who owns the 5 brand profiles).

## Tools

| Tool | What it does | Posts to social? |
|------|--------------|:---:|
| `list_brands` | List your brand profiles | no |
| `upload_media` | Upload a local video/image under a brand → draft post | no |
| `autocaption` | Analyze the media → title, caption, hashtags | no |
| `next_slots` | Next open time slots from the brand's schedule | no |
| `get_post` | Read a draft/scheduled post | no |
| `update_post` | Edit title/caption/hashtags/first_comment | no |
| `schedule_post` | Schedule to Upload-Post at a chosen slot | **YES** |

## Example flow

> "Schedule this video for RayvaughnCEO: /Users/ray/clips/tip.mp4"

Claude runs `upload_media` → `autocaption` → shows the caption + `next_slots`,
you tweak with `update_post` and pick a slot, and only after you say go does it
call `schedule_post`.

## Auth

Requests carry `x-internal-secret` + `x-impersonate-user`, the same internal
impersonation path the Fly worker uses (`api/_lib/supabase.js` `requireUser`).
The secret lives only in your local MCP env.
