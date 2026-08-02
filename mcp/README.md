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

The MCP authenticates with a dedicated secret you choose (`SCALESOLO_MCP_SECRET`).
The API accepts it via the same impersonation gate as the Fly worker, so no
worker secret is touched. Create it once and set it in Vercel + the MCP env:

```bash
# 1. generate a strong secret
openssl rand -hex 32                       # copy the output

# 2. set it on the API (from the linked ScaleSolo repo root), then redeploy
vercel env add SCALESOLO_MCP_SECRET production   # paste the value
vercel --prod                                    # or push to redeploy

# 3. use the SAME value as SCALESOLO_INTERNAL_SECRET in the Claude config below
```

## Claude config

Add to your Claude Code MCP config (`~/.claude.json` `mcpServers`, or
`claude mcp add`). Use the API host **`https://www.scalesolo.ai`** (the apex
`scalesolo.ai` 307-redirects and drops custom headers). Do NOT commit the secret.

```json
{
  "mcpServers": {
    "scalesolo": {
      "command": "node",
      "args": ["/absolute/path/to/Scalesolo/mcp/server.js"],
      "env": {
        "SCALESOLO_API_BASE": "https://www.scalesolo.ai",
        "SCALESOLO_INTERNAL_SECRET": "<the SCALESOLO_MCP_SECRET value>",
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
| `list_brands` | List your brand profiles + connected platforms | no |
| `upload_media` | Upload a local video/image under a brand → draft post | no |
| `autocaption` | Analyze the media → title, caption, hashtags | no |
| `add_to_backlog` | Upload one file + auto-caption → left in the calendar backlog | no |
| `batch_add_to_backlog` | Upload MANY files (list and/or a folder), each its own backlog post | no |
| `upload_carousel` | Several images → ONE carousel post in the backlog | no |
| `generate_image` | AI-generate image(s) (KIE.ai), billed to the brand's ScaleSolo credits | no (returns URLs) |
| `next_slots` | Next open time slots from the brand's schedule | no |
| `get_post` | Read a draft/scheduled post | no |
| `update_post` | Edit title/caption/hashtags/first_comment | no |
| `set_platforms` | Set which platforms a post targets | no |
| `schedule_post` | Schedule to Upload-Post at a chosen slot | **YES** |
| `post_now` | Publish immediately (no scheduler); Draft-mode brands land in the TikTok inbox now | **YES** |

## Example flow

> "Schedule this video for RayvaughnCEO: /Users/ray/clips/tip.mp4"

Claude runs `upload_media` → `autocaption` → shows the caption + `next_slots`,
you tweak with `update_post` and pick a slot, and only after you say go does it
call `schedule_post`.

## Auth

Requests carry `x-internal-secret` + `x-impersonate-user`, the same internal
impersonation path the Fly worker uses (`api/_lib/supabase.js` `requireUser`).
The secret lives only in your local MCP env.
