# ScaleSolo MCP

Drive ScaleSolo's posting pipeline for any of your brands from an MCP client
(Claude): **upload a video/image → auto-caption → pick a time slot → review →
schedule**. Nothing is posted automatically: only `schedule_post` and
`post_now` reach Upload-Post, and they're meant to run only after you confirm.

Email campaigns work the same way, with `schedule_email_campaign` as the only
tool that mails a real list. See [Email campaigns](#email-campaigns) below.

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
| `generate_video` | AI-generate a short video (Veo 3.1 via KIE.ai), billed to ScaleSolo credits | no (returns URL) |
| `next_slots` | Next open time slots from the brand's schedule | no |
| `get_post` | Read a draft/scheduled post | no |
| `update_post` | Edit title/caption/hashtags/first_comment | no |
| `set_platforms` | Set which platforms a post targets | no |
| `schedule_post` | Schedule to Upload-Post at a chosen slot | **YES** |
| `post_now` | Publish immediately (no scheduler); Draft-mode brands land in the TikTok inbox now | **YES** |

### Email campaigns

Same shape as the posting tools: everything prepares a draft and hands back a
`review_url` you open in ScaleSolo, and exactly one tool actually mails the
list.

| Tool | What it does | Mails anyone? |
|------|--------------|:---:|
| `list_email_campaigns` | Find a campaign by brand or status (use this to get a `campaign_id`) | no |
| `create_email_campaign` | Create a draft email for a brand | no |
| `update_email_campaign` | Edit a draft's subject, body, preview text or audience | no |
| `upload_email_image` | Put an image at a public URL so it loads in an inbox, and return email-safe `<img>` markup | no |
| `send_test_email` | Send ONE copy to an address you name | one test message |
| `schedule_email_campaign` | Schedule the campaign to the brand's real list | **YES** |

Three things are enforced server side, not just in these tools, so the web UI
cannot slip past them either:

1. **A test send is required.** `send` and `schedule` are refused (HTTP 428)
   until a test has gone out for the copy *as it currently stands*. Editing the
   subject, body or preview text voids the earlier test; changing the audience,
   from name or reply-to does not. Rewriting the copy of an already scheduled
   campaign pulls it back to draft, so test it and schedule it again.
2. **Merge tags must resolve.** Only `{{first_name}}`, `{{name}}`, `{{email}}`,
   `{{business}}` and `{{unsubscribe_url}}` work, double braces only. Anything
   else is refused (HTTP 422) with the full list of problems and the legal
   tags, because an unknown tag reaches the subscriber as literal braces.
3. **Images must be absolute https URLs.** A relative path or an inline `data:`
   URI looks right in the composer preview and arrives as a broken box in
   Gmail, so both are refused. Run `upload_email_image` first.

`schedule_email_campaign` will not guess a timezone: pass an offset
(`2026-11-02T09:00:00-05:00`) or a bare local time plus
`timezone: "America/Chicago"`.

## Example flow

> "Schedule this video for RayvaughnCEO: /Users/ray/clips/tip.mp4"

Claude runs `upload_media` → `autocaption` → shows the caption + `next_slots`,
you tweak with `update_post` and pick a slot, and only after you say go does it
call `schedule_post`.

> "Draft Sanabreh an email about Friday lamb chops, with this photo:
> /Users/ray/Desktop/lamb.jpg"

Claude runs `upload_email_image` → `create_email_campaign` with the returned
markup → gives you the `review_url`. You read it, it sends a test to your own
address with `send_test_email`, and only after you confirm does it call
`schedule_email_campaign`.

## Auth

Requests carry `x-internal-secret` + `x-impersonate-user`, the same internal
impersonation path the Fly worker uses (`api/_lib/supabase.js` `requireUser`).
The secret lives only in your local MCP env.
