#!/usr/bin/env python3
"""
Stage 1 of the VTM website-rebuild outreach pipeline.

For each Google Places lead that has a website:
  - fetch the homepage (browser UA, follows redirects, short timeout)
  - extract a contact email (mailto: first, then a regex on the page, then
    one fallback fetch of /contact or /contact-us)
  - score it 1-10 on REDESIGN OPPORTUNITY from HTML signals
    (high score = strong prospect: outdated, not mobile-ready, stale, etc.)

Writes leads-scored.json sorted by score (best prospects first). This is the
fast first pass; the top candidates then get a visual screenshot review before
we pick the pilot 8. No emails are sent here.

Pure stdlib + certifi. Concurrent fetches.
"""
import json, re, ssl, sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path
from urllib.request import Request, urlopen
from urllib.parse import urljoin, urlparse

HERE = Path(__file__).parent
RAW = HERE / "leads-raw.json"
OUT = HERE / "leads-scored.json"

try:
    import certifi
    CTX = ssl.create_default_context(cafile=certifi.where())
except ImportError:
    CTX = ssl.create_default_context()

UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/124.0 Safari/537.36")

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+\-]+@[A-Za-z0-9.\-]+\.[A-Za-z]{2,}")
JUNK_EMAIL = ("example.com", "sentry.", "wixpress.com", ".png", ".jpg", ".gif",
              "@sentry", "yourdomain", "domain.com", "email.com", "godaddy",
              "u003e", "schema.org", "@2x", "core.js",
              # font/library/CDN author emails that leak from CSS/JS comments
              "impallari", "googleapis", "gstatic", "w3.org", "jquery",
              "bootstrap", "cloudflare", "fontawesome", ".css", ".js",
              "googlegroups", "googlemail.com/maps", "name@", "user@", "info@info")
CURRENT_YEAR = 2026


def fetch(url, timeout=12):
    req = Request(url, headers={"User-Agent": UA, "Accept": "text/html"})
    with urlopen(req, timeout=timeout, context=CTX) as r:
        final = r.geturl()
        raw = r.read(800_000)  # cap
        charset = r.headers.get_content_charset() or "utf-8"
        return final, raw.decode(charset, errors="replace")


def clean_emails(found):
    out = []
    for e in found:
        el = e.lower()
        if any(j in el for j in JUNK_EMAIL):
            continue
        if el in out:
            continue
        out.append(el)
    return out


def find_email(html, base_url):
    # mailto: wins
    mailtos = re.findall(r'mailto:([^"\'>?\s]+)', html, re.I)
    cands = clean_emails(mailtos)
    if cands:
        return cands[0], "mailto"
    # plain regex on page
    cands = clean_emails(EMAIL_RE.findall(html))
    if cands:
        return cands[0], "page"
    # one fallback: a contact page
    for path in ("/contact", "/contact-us", "/contact.html"):
        try:
            _, chtml = fetch(urljoin(base_url, path), timeout=8)
        except Exception:
            continue
        m = re.findall(r'mailto:([^"\'>?\s]+)', chtml, re.I)
        c = clean_emails(m) or clean_emails(EMAIL_RE.findall(chtml))
        if c:
            return c[0], "contact-page"
    return None, None


def score_site(html, final_url):
    """Return (score 1-10, reasons[]). Higher = more redesign opportunity."""
    h = html.lower()
    score = 0
    reasons = []

    # not mobile responsive
    if 'name="viewport"' not in h and "name='viewport'" not in h:
        score += 3; reasons.append("no mobile viewport meta (not responsive)")
    if "@media" not in h and "max-width" not in h:
        score += 1; reasons.append("no media queries detected")

    # stale copyright year
    years = [int(y) for y in re.findall(r"(?:©|&copy;|copyright)[^0-9]{0,12}(20[0-2][0-9])", h)]
    if years:
        newest = max(years)
        if newest <= CURRENT_YEAR - 3:
            score += 3; reasons.append(f"stale copyright year {newest}")
        elif newest <= CURRENT_YEAR - 1:
            score += 1; reasons.append(f"copyright year {newest}")

    # legacy build signals
    if "<table" in h and ("width=" in h or "cellpadding" in h):
        score += 2; reasons.append("table-based layout")
    if "<font" in h or "bgcolor=" in h:
        score += 2; reasons.append("legacy HTML tags (font/bgcolor)")
    if re.search(r"\.(jpg|png|gif)['\"]", h) and h.count("<img") > 25:
        score += 1; reasons.append("very image-heavy")

    # platform hints
    if "wix.com" in h or "wixstatic" in h:
        reasons.append("platform: Wix")
    elif "squarespace" in h:
        reasons.append("platform: Squarespace")
    elif "wp-content" in h or "wordpress" in h:
        score += 1; reasons.append("platform: WordPress")
    elif "godaddy" in h or "websitebuilder" in h:
        score += 2; reasons.append("platform: GoDaddy builder")

    # no SSL
    if final_url.startswith("http://"):
        score += 2; reasons.append("no HTTPS")

    # thin / placeholder
    text = re.sub(r"<[^>]+>", " ", html)
    words = len(text.split())
    if words < 250:
        score += 2; reasons.append(f"very thin content (~{words} words)")

    # no modern framework / minimal styling
    if "flex" not in h and "grid" not in h and "@media" not in h:
        score += 1; reasons.append("no modern CSS layout (flex/grid)")

    score = max(1, min(10, score))
    return score, reasons


def process(lead):
    site = lead.get("website")
    rec = {
        "title": lead.get("title"),
        "category": lead.get("categoryName"),
        "city": lead.get("city"),
        "reviews": lead.get("reviewsCount"),
        "rating_google": lead.get("totalScore"),
        "phone": lead.get("phone"),
        "website": site,
        "final_url": None,
        "email": None,
        "email_source": None,
        "score": 0,
        "reasons": [],
        "error": None,
    }
    try:
        final, html = fetch(site)
        rec["final_url"] = final
        email, src = find_email(html, final)
        rec["email"], rec["email_source"] = email, src
        rec["score"], rec["reasons"] = score_site(html, final)
    except Exception as e:
        rec["error"] = f"{type(e).__name__}: {e}"
        rec["score"] = 0
        rec["reasons"] = ["fetch failed"]
    return rec


def main():
    leads = [l for l in json.loads(RAW.read_text()) if l.get("website")]
    print(f"Fetching + scoring {len(leads)} sites...", flush=True)
    results = []
    with ThreadPoolExecutor(max_workers=12) as ex:
        futs = {ex.submit(process, l): l for l in leads}
        done = 0
        for f in as_completed(futs):
            results.append(f.result())
            done += 1
            if done % 20 == 0:
                print(f"  {done}/{len(leads)}", flush=True)
    results.sort(key=lambda r: (r["score"], r["reviews"] or 0), reverse=True)
    OUT.write_text(json.dumps(results, indent=2, ensure_ascii=False) + "\n")

    ok = [r for r in results if not r["error"]]
    withmail = [r for r in ok if r["email"]]
    print(f"\nDone. Reachable sites: {len(ok)}/{len(leads)} | with email: {len(withmail)}")
    print("\nTop 15 prospects (score, email?, title):")
    for r in results[:15]:
        em = r["email"] or "NO EMAIL"
        print(f"  {r['score']:>2}  {em:<32} {r['title'][:38]}")


if __name__ == "__main__":
    main()
