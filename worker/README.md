# ScaleSolo Render Worker

Long-running render jobs that don't fit Vercel's 60s ceiling. Currently:

- `POST /jobs/polish` — same body as `/api/videos/polish` on the Vercel side. Runs ffmpeg with bundled fonts, no GitHub round-trip per cold start, no time limit.
- `POST /jobs/title-png` — renders a title overlay PNG via SVG + sharp. **100% accurate centering** (per-line `text-anchor="middle"`, real glyph metrics) — replaces the broken whitespace-padding hack the old `drawtext` path used because ffmpeg < 7.0 has no `text_align`.
- `GET /healthz` — uptime probe for Railway / Fly load balancer.

## Deploy on Fly.io (recommended, ~$5-15/mo)

1. Install flyctl: `brew install flyctl` (or [other platforms](https://fly.io/docs/hands-on/install-flyctl/)).
2. Auth: `fly auth signup` (or `fly auth login`).
3. From the **worker/** directory: `fly launch --no-deploy --copy-config`. When asked, accept the existing `fly.toml` — DO NOT let Fly overwrite it.
4. If `scalesolo-worker` is taken, edit `fly.toml` and change `app = "..."` to a unique name (e.g. `yourname-scalesolo-worker`).
5. Set secrets (same values as Vercel):
   ```sh
   fly secrets set \
     SUPABASE_URL="https://YOURPROJECT.supabase.co" \
     SUPABASE_SERVICE_KEY="eyJ..." \
     WORKER_SHARED_SECRET="$(openssl rand -hex 32)"
   ```
6. Deploy: `fly deploy`.
7. Get the public URL: `fly status` (look for the Hostname).
8. On **Vercel** → Settings → Environment Variables, add:
   - `WORKER_URL` — e.g. `https://scalesolo-worker.fly.dev`
   - `WORKER_SHARED_SECRET` — same value from step 5
   - Redeploy.

That's it. `/api/videos/polish` will now detect `WORKER_URL` and route every composite through the Fly worker — ffmpeg runs natively in ~10-15s instead of waiting on Shotstack's render queue (20-60s). ZapCap captions still chain on after.

### Speed expectations
- 30s 1080p clip, title + watermark + music: **~10-15s** composite + **30-90s** ZapCap captions = ~45-105s total per clip
- 5 clips at concurrency 3 from the canvas: **~60-90s** wall clock (down from ~3-5 min on Shotstack)

### Cost
- Fly.io `shared-cpu-2x` with 2 GB RAM, auto-suspended when idle: **~$3-8/mo** at low/medium volume.
- Saves Shotstack render minutes (~$0.25/min) for every polish that routes through the worker.

## Deploy on Railway (alternative)

1. **New project → Deploy from GitHub repo** → select this repo.
2. Set the **root directory** to `worker/` (Settings → Source → Root Directory).
3. Railway auto-detects the Dockerfile.
4. Add env vars (Settings → Variables):
   - `SUPABASE_URL`           — same as Vercel
   - `SUPABASE_SERVICE_KEY`   — same as Vercel (service role)
   - `WORKER_SHARED_SECRET`   — generate any long random string
   - `PORT`                   — Railway sets this automatically; leave unset
5. After first deploy, copy the public URL Railway gives you (e.g. `https://scalesolo-worker-production.up.railway.app`).
6. On **Vercel**, set:
   - `WORKER_URL`             — Railway URL from step 5
   - `WORKER_SHARED_SECRET`   — same value as Railway
   - Redeploy once.

That's it. The Vercel `/api/videos/polish` route will detect `WORKER_URL` and forward to Railway transparently.

## Bundling fonts

Drop `.ttf` files into `worker/fonts/` matching the names in `index.js` (`Poppins-ExtraBold.ttf`, `Montserrat-ExtraBold.ttf`, etc.). They get base64-embedded into each title's SVG so glyph widths are exact and centering is pixel-perfect.

If a font file is missing the worker still renders — sharp falls back to a system sans-serif. The title still centers correctly because the SVG renderer uses real glyph metrics either way.

## Local dev

```sh
cd worker
npm install
SUPABASE_URL=... SUPABASE_SERVICE_KEY=... npm run dev
```

Hit it:

```sh
curl -X POST http://localhost:8080/jobs/title-png \
  -H 'content-type: application/json' \
  --data '{"title":"hello world","size":80,"bg_color":"#e0467a"}' \
  --output title.png
```
