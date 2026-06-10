#!/usr/bin/env python3
"""Screenshot the emailable shortlist for visual review. Writes PNGs to
/tmp/leadshots/ (TCC: Chrome can't reliably write under ~/Desktop)."""
import json, re, subprocess
from pathlib import Path

CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
OUT = Path("/tmp/leadshots"); OUT.mkdir(exist_ok=True)
JUNK = ("latofonts", "fonts.com")

d = json.load(open(Path(__file__).parent / "leads-scored.json"))
cands = [r for r in d if r["email"] and not r["error"] and r["score"] >= 3
         and not any(j in r["email"] for j in JUNK)]

manifest = []
for i, r in enumerate(cands):
    slug = re.sub(r"[^a-z0-9]+", "-", r["title"].lower()).strip("-")[:40]
    png = OUT / f"{i:02d}_{slug}.png"
    url = r["final_url"] or r["website"]
    try:
        subprocess.run([CHROME, "--headless=new", "--disable-gpu",
                        "--hide-scrollbars", "--window-size=1440,1700",
                        "--virtual-time-budget=9000",
                        f"--screenshot={png}", url],
                       timeout=40, capture_output=True)
        ok = png.exists() and png.stat().st_size > 2000
    except Exception:
        ok = False
    print(f"{'OK ' if ok else 'FAIL'} {png.name:<46} {r['email']:<32} {url}")
    manifest.append({**r, "shot": str(png) if ok else None})

(OUT / "manifest.json").write_text(json.dumps(manifest, indent=2, ensure_ascii=False))
print(f"\n{sum(1 for m in manifest if m['shot'])}/{len(manifest)} shots captured -> {OUT}")
