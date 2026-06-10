#!/usr/bin/env python3
"""
Generate a Sanabreh Influencer Pass (4:5 PNG) for a creator.

- Pulls the creator's TikTok profile photo and embeds it (base64) so the pass
  never breaks when TikTok's signed URL expires.
- Assigns the next sequential 4-digit number by booking order (registry), or
  reuses the creator's existing number if already issued.
- Renders to PNG with local headless Chrome.

Usage:
    python3 scripts/make-pass.py --handle tiffanytiannaa --name "Tiffany"
    python3 scripts/make-pass.py --handle negrafeminist --name "Nazeleh Booker"
    python3 scripts/make-pass.py --handle foo --name "Foo" --no-photo
    python3 scripts/make-pass.py --handle foo --name "Foo" --number 5   # force a number

Output: scripts/assets/passes/Sanabreh-Pass-NNNN-Name.png (also copied to ~/Desktop)
"""
import argparse, base64, json, re, subprocess, sys, tempfile
from pathlib import Path

HERE = Path(__file__).parent
ASSETS = HERE / "assets"
PASSES = ASSETS / "passes"
REGISTRY = HERE / "influencer-pass-registry.json"
BG_CACHE = ASSETS / "bg_lamb_chops.jpg"
BG_URL = "https://sanabrehrestaurant.com/images/lamb_chops.jpg"
DESKTOP = Path.home() / "Desktop"
CHROME = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
BRAVE = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser"

UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36"


def curl(url, out, referer=None):
    cmd = ["curl", "-s", "-A", UA, url, "-o", str(out)]
    if referer:
        cmd[2:2] = ["-e", referer]
    subprocess.run(cmd, check=True)
    return Path(out).exists() and Path(out).stat().st_size > 0


def b64(path, mime):
    return f"data:{mime};base64," + base64.b64encode(Path(path).read_bytes()).decode()


def get_bg_data():
    if not BG_CACHE.exists():
        curl(BG_URL, BG_CACHE)
    return b64(BG_CACHE, "image/jpeg")


def get_avatar_data(handle):
    with tempfile.TemporaryDirectory() as td:
        html = Path(td) / "p.html"
        if not curl(f"https://www.tiktok.com/@{handle}", html, referer="https://www.tiktok.com/"):
            return None
        text = html.read_text(errors="replace")
        mm = re.search(r'"avatarLarger":"([^"]*)"', text) or re.search(r'"avatarMedium":"([^"]*)"', text)
        if not mm:
            return None
        url = mm.group(1).encode().decode("unicode_escape")
        av = Path(td) / "a.jpg"
        if not curl(url, av, referer="https://www.tiktok.com/"):
            return None
        return b64(av, "image/jpeg")


def next_number(handle, forced=None):
    reg = json.loads(REGISTRY.read_text()) if REGISTRY.exists() else {}
    if handle in reg and forced is None:
        return reg[handle], reg
    n = forced if forced is not None else (max(reg.values()) + 1 if reg else 1)
    reg[handle] = n
    REGISTRY.write_text(json.dumps(reg, indent=2) + "\n")
    return n, reg


TEMPLATE = """<!doctype html><html><head><meta charset="utf-8">
<link href="https://fonts.googleapis.com/css2?family=Cinzel:wght@500;700&family=Cormorant+Garamond:ital,wght@0,500;1,500&family=DM+Sans:wght@400;500;600&display=swap" rel="stylesheet">
<style>
:root{{--gold:#C9A84C;--gold-lt:#E2C97E;--cream:#F5EDD8;--ink:#0A0A08}}
*{{margin:0;padding:0;box-sizing:border-box}}
html,body{{background:#0A0A08}}
.pass{{position:relative;width:1080px;height:1350px;overflow:hidden;background:#0A0A08;font-family:'DM Sans',sans-serif;color:var(--cream)}}
.pass::before{{content:'';position:absolute;inset:0;background:url('{bg}') center/cover no-repeat;filter:saturate(1.05) brightness(.55)}}
.pass::after{{content:'';position:absolute;inset:0;background:radial-gradient(120% 80% at 50% 30%, rgba(0,0,0,.10), rgba(0,0,0,.80) 80%),linear-gradient(180deg, rgba(10,10,8,.55) 0%, rgba(10,10,8,.30) 38%, rgba(10,10,8,.85) 100%)}}
.frame{{position:absolute;inset:38px;border:2px solid rgba(201,168,76,.55);z-index:2}}
.frame::before{{content:'';position:absolute;inset:10px;border:1px solid rgba(226,201,126,.28)}}
.content{{position:relative;z-index:3;height:100%;display:flex;flex-direction:column;align-items:center;text-align:center;padding:84px 80px}}
.wordmark{{font-family:'Cinzel',serif;font-weight:700;font-size:60px;letter-spacing:.10em;background:linear-gradient(180deg,var(--gold-lt),var(--gold));-webkit-background-clip:text;background-clip:text;color:transparent;line-height:1}}
.sub{{font-weight:500;font-size:18px;letter-spacing:.42em;text-transform:uppercase;color:var(--cream);opacity:.9;margin-top:12px}}
.rule{{width:120px;height:2px;background:linear-gradient(90deg,transparent,var(--gold),transparent);margin:22px auto}}
.mid{{flex:1;width:100%;display:flex;flex-direction:column;align-items:center;justify-content:center}}
.avatar{{width:400px;height:400px;border-radius:50%;margin:0 auto;background:url('{avatar}') center/cover, #1a1a18;border:5px solid var(--gold);box-shadow:0 0 0 3px rgba(226,201,126,.35),0 12px 48px rgba(0,0,0,.6)}}
.welcome{{font-family:'Cormorant Garamond',serif;font-style:italic;font-weight:500;font-size:56px;color:var(--cream);margin-top:48px}}
.host{{font-family:'Cormorant Garamond',serif;font-size:36px;color:var(--cream);opacity:.86;margin-top:6px}}
.tag{{margin-top:44px;display:inline-block;font-weight:600;font-size:23px;letter-spacing:.46em;text-transform:uppercase;color:var(--ink);background:linear-gradient(180deg,var(--gold-lt),var(--gold));padding:13px 32px 13px 38px;border-radius:999px}}
.name{{font-family:'Cinzel',serif;font-weight:700;font-size:88px;line-height:1.04;color:var(--cream);margin-top:32px;text-shadow:0 2px 18px rgba(0,0,0,.5)}}
.num-wrap{{display:flex;flex-direction:column;align-items:center;gap:12px}}
.num-label{{font-size:16px;letter-spacing:.40em;text-transform:uppercase;color:var(--gold-lt);opacity:.85}}
.num{{font-family:'Cinzel',serif;font-weight:700;font-size:58px;letter-spacing:.14em;color:var(--gold);border:2px solid rgba(201,168,76,.6);border-radius:14px;padding:12px 34px;background:rgba(10,10,8,.35)}}
</style></head><body>
<div class="pass"><div class="frame"></div><div class="content">
<div class="wordmark">Sanabreh</div>
<div class="sub">Mediterranean Restaurant</div>
<div class="rule"></div>
<div class="mid">
{avatar_block}
<div class="welcome">Welcome to Sanabreh</div>
<div class="host">We are so excited to host you</div>
<div class="tag">Influencer</div>
<div class="name">{name}</div>
</div>
<div class="num-wrap"><div class="num-label">Guest No.</div><div class="num">{number}</div></div>
</div></div></body></html>"""


def render(html_path, png_path):
    binary = CHROME if Path(CHROME).exists() else BRAVE
    subprocess.run([binary, "--headless=new", "--disable-gpu", "--hide-scrollbars",
                    "--force-device-scale-factor=2", "--window-size=1080,1350",
                    "--virtual-time-budget=9000", f"--screenshot={png_path}",
                    f"file://{html_path}"], check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--handle", required=True)
    ap.add_argument("--name", required=True)
    ap.add_argument("--number", type=int, default=None)
    ap.add_argument("--no-photo", action="store_true")
    ap.add_argument("--photo", help="Path to a local image to use as the avatar (overrides TikTok fetch).")
    args = ap.parse_args()
    PASSES.mkdir(parents=True, exist_ok=True)

    num, _ = next_number(args.handle.lower(), args.number)
    num_str = f"{num:04d}"

    if args.photo:
        ext = Path(args.photo).suffix.lower()
        mime = "image/png" if ext == ".png" else "image/jpeg"
        avatar = b64(args.photo, mime)
    else:
        avatar = None if args.no_photo else get_avatar_data(args.handle)
    avatar_block = f'<div class="avatar"></div>' if avatar else ""
    html = TEMPLATE.format(bg=get_bg_data(), avatar=avatar or "", avatar_block=avatar_block,
                           name=args.name, number=num_str)

    safe = re.sub(r"[^A-Za-z0-9]+", "-", args.name).strip("-")
    out = PASSES / f"Sanabreh-Pass-{num_str}-{safe}.png"
    with tempfile.NamedTemporaryFile("w", suffix=".html", delete=False) as f:
        f.write(html); html_path = f.name
    render(html_path, out)
    if out.exists():
        (DESKTOP / out.name).write_bytes(out.read_bytes())
        print(f"Created pass No.{num_str} for {args.name}")
        print(f"  {out}")
        print(f"  copied to Desktop/{out.name}")
        print(f"  photo: {'embedded' if avatar else 'none (no-photo or fetch failed)'}")
    else:
        sys.exit("Render failed (no PNG produced).")


if __name__ == "__main__":
    main()
