# ScaleSolo render worker. Runs on Fly performance-4x machines.
# Bundles ffmpeg (via @ffmpeg-installer), sharp/resvg, AND Chrome (via
# puppeteer) so it can render the Studio HyperFrames pipeline end-to-end
# without depending on Vercel's 5-min function ceiling.

# Node 22 has native WebSocket support — required by the recent
# @supabase/supabase-js (v2.45+) realtime client. Node 20 without
# the `ws` polyfill crashes createClient the moment the worker
# uploads its ffmpeg output to Storage.
FROM node:22-slim

# Chrome's system dependencies. fontconfig also powers sharp's SVG
# @font-face mapping. The rest are libs Chrome itself can't ship —
# font / render / audio stack. Without these, Puppeteer's bundled
# Chrome fails to launch with "shared libraries: error while loading."
RUN apt-get update && apt-get install -y --no-install-recommends \
    fontconfig \
    ca-certificates \
    fonts-liberation \
    libasound2 \
    libatk-bridge2.0-0 \
    libatk1.0-0 \
    libatspi2.0-0 \
    libcairo2 \
    libcups2 \
    libdbus-1-3 \
    libdrm2 \
    libgbm1 \
    libglib2.0-0 \
    libgtk-3-0 \
    libnspr4 \
    libnss3 \
    libpango-1.0-0 \
    libx11-6 \
    libx11-xcb1 \
    libxcb1 \
    libxcomposite1 \
    libxdamage1 \
    libxext6 \
    libxfixes3 \
    libxkbcommon0 \
    libxrandr2 \
    wget \
    xdg-utils \
    ffmpeg \
    aubio-tools \
  && rm -rf /var/lib/apt/lists/*

# Use the modern system ffmpeg (apt) over @ffmpeg-installer/ffmpeg.
# Debian bookworm ships ffmpeg 5.x, which has xfade + amix normalize=0
# + acrossfade etc. The bundled @ffmpeg-installer is on ffmpeg 4.0
# from 2018 — missing half the filters our pipeline needs.
ENV FFMPEG_PATH=/usr/bin/ffmpeg

WORKDIR /app
COPY package.json ./

# Register bundled fonts (Plus Jakarta Sans 800 used by the brand-content
# pipeline) so fontconfig / sharp / ffmpeg / resvg can find them by name.
COPY fonts/ /usr/local/share/fonts/
RUN fc-cache -fv > /dev/null 2>&1

# Install Node deps. Puppeteer downloads Chrome to /root/.cache/puppeteer
# during this step, baking it into the image so there's no per-cold-start
# fetch at job time.
ENV PUPPETEER_CACHE_DIR=/root/.cache/puppeteer
RUN npm install --omit=dev

COPY . .

ENV NODE_ENV=production
ENV PORT=8080
EXPOSE 8080

CMD ["node", "index.js"]
