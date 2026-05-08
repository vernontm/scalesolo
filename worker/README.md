# ScaleSolo Render Worker

Long-running render jobs that don't fit Vercel's 60s ceiling. Currently:

- `POST /jobs/polish` — same body as `/api/videos/polish` on the Vercel side. Runs ffmpeg with bundled fonts, no GitHub round-trip per cold start, no time limit.
- `POST /jobs/title-png` — renders a title overlay PNG via SVG + sharp. **100% accurate centering** (per-line `text-anchor="middle"`, real glyph metrics) — replaces the broken whitespace-padding hack the old `drawtext` path used because ffmpeg < 7.0 has no `text_align`.
- `GET /healthz` — uptime probe for Railway / load balancer.

## Deploy on Railway

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
