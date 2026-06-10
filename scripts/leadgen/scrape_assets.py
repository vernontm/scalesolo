#!/usr/bin/env python3
"""
Overlay each lead's REAL site images onto its demo. Run AFTER build_sites.py:
stock images are the base; this replaces hero/about/band/g1-g4 with the best
real photos scraped from the live site. Slots it cannot fill keep the stock
fallback, so a demo is never left with a broken/empty image.

Also downloads the site's logo to assets/logo.png when found (not auto-wired
into the header; available for manual use).
"""
import re, ssl, urllib.request, certifi
from urllib.parse import urljoin
from pathlib import Path

CTX = ssl.create_default_context(cafile=certifi.where())
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
ROOT = Path(__file__).parent / "vtm-demos"

SITES = {
 "coco-nail-spa": "https://coconailspahouston.com/",
 "infinity-nail-spa": "https://infinitynailspahouston.com/",
 "plush-nail-bar": "https://plushnailbarus.com/",
 "milano-nail-spa": "https://milanonailspameyerland.com/",
 "sofia-grace-nails": "https://sofiagracenails.com/",
 "prestige-hand-car-wash": "https://prestigehandcarwash.com/",
 "totoro-mochi-donut": "https://www.totoromochidonut.com/",
 "kokee-tea": "https://www.kokeetea.com/",
}

BAD = ("icon", "logo", "sprite", "loader", "dummy", "placeholder", "blank",
       "facebook", "google", "yelp", "instagram", "twitter", "tiktok",
       "favicon", "avatar", "badge", "arrow", "star", "1x1", "spacer",
       "cookie", "pixel", "/emoji", "wp-emoji")
DIM_RE = re.compile(r"-(\d{2,4})x(\d{2,4})\.")          # -600x400.
SLOTS = ["hero", "about", "band", "g1", "g2", "g3", "g4"]


def get(url, timeout=20):
    return urllib.request.urlopen(
        urllib.request.Request(url, headers={"User-Agent": UA}), timeout=timeout, context=CTX)


def collect(site):
    html = get(site).read().decode("utf-8", "replace")
    urls = set()
    for pat in (r'<img[^>]+src=["\']([^"\']+)', r'data-src=["\']([^"\']+)',
                r'data-lazy-src=["\']([^"\']+)', r'background-image:\s*url\(["\']?([^"\')]+)'):
        for m in re.findall(pat, html, re.I):
            urls.add(m)
    # srcset: take the largest candidate
    for ss in re.findall(r'srcset=["\']([^"\']+)', html, re.I):
        parts = [p.strip().split()[0] for p in ss.split(",") if p.strip()]
        if parts:
            urls.add(parts[-1])
    og = re.findall(r'property=["\']og:image["\'][^>]*content=["\']([^"\']+)', html, re.I)
    logo = [u for u in urls if "logo" in u.lower()]
    photos = []
    for u in urls:
        ul = u.lower()
        if u.startswith("data:") or ul.endswith((".svg", ".gif")):
            continue
        if any(b in ul for b in BAD):
            continue
        photos.append(urljoin(site, u))
    photos = [urljoin(site, u) for u in og] + photos  # og:image first
    return photos, ([urljoin(site, logo[0])] if logo else [])


def base_key(u):
    """collapse -WxH variants so we keep one entry per real photo"""
    return DIM_RE.sub(".", u.split("?")[0])


def rank(photos):
    seen, ranked = {}, []
    for u in photos:
        try:
            with get(u, 15) as r:
                cl = int(r.headers.get("content-length") or 0)
                ct = r.headers.get("content-type", "")
        except Exception:
            continue
        if "image" not in ct or cl < 18000:        # skip icons/thumbs
            continue
        m = DIM_RE.search(u)
        if m and (int(m.group(1)) < 400 or int(m.group(2)) < 300):
            continue
        k = base_key(u)
        if k not in seen or cl > seen[k][0]:
            seen[k] = (cl, u)
    return [u for _, u in sorted(seen.values(), reverse=True)]


def run():
    print(f"Overlaying real images for {len(SITES)} sites...\n")
    summary = {}
    for slug, site in SITES.items():
        adir = ROOT / slug / "assets"
        try:
            photos, logo = collect(site)
            ranked = rank(photos)
        except Exception as e:
            print(f"  {slug:<24} SCRAPE FAIL ({type(e).__name__}); keeping stock")
            summary[slug] = 0
            continue
        # assign distinct photos to slots; reuse for band if needed
        filled = 0
        for i, slot in enumerate(SLOTS):
            src = None
            if slot == "band" and ranked:
                src = ranked[1 % len(ranked)]
            elif i < len(ranked):
                src = ranked[i]
            if not src:
                continue
            try:
                data = get(src, 25).read()
                if len(data) > 12000:
                    (adir / f"{slot}.jpg").write_bytes(data)
                    filled += 1
            except Exception:
                pass
        if logo:
            try:
                (adir / "logo.png").write_bytes(get(logo[0], 20).read())
            except Exception:
                pass
        summary[slug] = filled
        print(f"  {slug:<24} {len(ranked):>2} usable photos -> filled {filled}/7 slots"
              + (f", +logo" if logo else ""))
    print("\nDone. (slots not filled keep their stock fallback)")
    weak = [s for s, n in summary.items() if n < 4]
    if weak:
        print("LOW REAL-IMAGE COVERAGE (mostly stock):", ", ".join(weak))


if __name__ == "__main__":
    run()
