# ScaleSolo render worker. Designed for Railway / Fly / any Docker host.
# Includes ffmpeg via @ffmpeg-installer (no system install needed) plus
# sharp for the SVG → PNG title renderer.

# Node 22 has native WebSocket support — required by the recent
# @supabase/supabase-js (v2.45+) realtime client. Node 20 without
# the `ws` polyfill crashes the supabase createClient call with
# "Node.js 20 detected without native WebSocket support" the moment
# the worker tries to upload its ffmpeg output back to Storage.
FROM node:22-slim

# fontconfig is required for sharp's SVG @font-face rendering to map
# our embedded TTFs onto glyphs. Tiny, cheap, much smaller than the
# whole fonts-recommended bundle.
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
  && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY package.json ./
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
