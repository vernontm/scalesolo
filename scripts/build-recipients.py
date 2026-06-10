#!/usr/bin/env python3
"""
Build scripts/outreach-recipients.json from TikTok scraper JSON dumps.

Filters to a clean, sendable list:
  - must have an email
  - Houston-area (bio/name mentions Houston/HTX, or TX with no other-city signal)
  - followers <= MAX_FOLLOWERS (skip agency-managed mega creators)
  - drop obvious venues/restaurants (not creators)
  - drop anyone already in outreach-sent-log.txt
  - dedupe by email (case-insensitive)

Usage:
    python3 scripts/build-recipients.py  path/to/file1.json path/to/file2.json ...
Prints stats and writes scripts/outreach-recipients.json.
"""

import json
import re
import sys
import unicodedata
from pathlib import Path

MAX_FOLLOWERS = 250_000

HERE = Path(__file__).parent
OUT_FILE = HERE / "outreach-recipients.json"
SENT_LOG = HERE / "outreach-sent-log.txt"

HOUSTON_TOKENS = ["houston", "htx", "h-town", "htown", "h town", "htx."]
OTHER_CITY_TOKENS = [
    "nyc", "new york", " nj", "chicago", "dallas", "austin", "atlanta", " atl",
    "charlotte", " clt", "san diego", "columbus", "oklahoma", "baton rouge",
    "rva", "richmond", "minnesota", " mn", " miami", "boston", "dubai",
    "seattle", "denver", "vegas", "capital region", "nyc/nj", "nc/va", " la ",
]
# Words that are not real first names (when derived from handle/display).
NAME_STOPLIST = {
    "houston", "houston's", "htx", "the", "food", "foodie", "eats", "texas",
    "tx", "mr", "mr.chimetime", "dr", "dr.", "chef", "taste", "brown", "high",
    "da", "lil", "fork", "taco", "hungry", "becoming", "skill", "dine", "discover",
    "eatinwitsantana", "itz", "heat", "jamaica", "tacos", "tacos.frontera",
    "bussit", "kimmy", "sadezy", "dosesofvenus", "michitexeats", "crooklyn_j|houston",
    "hungryshrks", "renzoeats", "domcreviews", "alsonlovesfood", "vvfoodfiles",
    "listen2larra", "thehoustonfoodie", "thenabilaismail", "iamjaneesamaria",
    "iamqbea", "neidasuzeth", "kristinaugc", "marteats", "mostasting",
    "boomkackmua", "meccavellii", "misslado", "phatvick", "titofortheworld",
}
VENUE_TOKENS = [
    "eatery", "sports bar", "food truck", " llc", "catering", "dm to order",
    "order on", "locations", "hours-", "open ", " menu", "served at",
    "best kookies", "best cookies", "ste ", "suite", "no n masón",
]
VENUE_HANDLE_HINTS = [
    "eatery", "tacos", "bbq", "kookies", "cookies", "truck", "wingz",
    "frontera", "gorditos", "budzzz", "brownsugarco", "jamaicapondi",
    "holysmokes", "kimmyyumyum",
]
ADDRESS_RE = re.compile(r"\b\d{3,5}\s+\w+.*\b(rd|st|blvd|ave|dr|hwy|ste|suite)\b", re.I)


def load_sent():
    sent = set()
    if SENT_LOG.exists():
        for line in SENT_LOG.read_text().splitlines():
            line = line.strip().lower()
            if line and not line.startswith("#"):
                sent.add(line)
    return sent


def is_houston(text):
    t = text.lower()
    if any(tok in t for tok in HOUSTON_TOKENS):
        return True
    has_tx = bool(re.search(r"\btx\b", t)) or "texas" in t
    has_other = any(tok in t for tok in OTHER_CITY_TOKENS)
    return has_tx and not has_other


def looks_like_venue(rec, text):
    t = text.lower()
    handle = rec.get("handle", "").lower()
    if any(h in handle for h in VENUE_HANDLE_HINTS):
        return True
    if any(tok in t for tok in VENUE_TOKENS):
        return True
    if ADDRESS_RE.search(rec.get("bio", "")):
        return True
    return False


def _strip_accents(s):
    return "".join(c for c in unicodedata.normalize("NFKD", s) if not unicodedata.combining(c))


def clean_name(rec):
    """Best-effort real first name from display_name, else 'there'.

    Conservative on purpose: a wrong or handle-derived greeting reads as
    auto-generated, so when in doubt we fall back to 'there'.
    """
    handle_key = re.sub(r"[^a-z0-9]", "", rec.get("handle", "").lower())
    src = _strip_accents(rec.get("display_name", "") or "").replace("’", "'")
    src = re.split(r"[|•·☆➤/(),:_]", src)[0]   # cut at separators
    src = re.split(r"\d", src)[0]               # stop before digits
    src = re.sub(r"[^A-Za-z'’\- ]", " ", src).strip()
    parts = src.split()
    if not parts:
        return "there"
    token = parts[0]
    low = token.lower()
    namekey = re.sub(r"[^a-z0-9]", "", low)
    # reject: stoplist words, handle-derived, camelCase brand handles,
    # vowel-less tokens, and odd lengths
    if low in NAME_STOPLIST:
        return "there"
    if namekey and namekey == handle_key:
        return "there"
    if re.search(r"[a-z][A-Z]", token):
        return "there"
    if not re.search(r"[aeiouAEIOU]", token):
        return "there"
    if not (2 <= len(token) <= 12):
        return "there"
    # normalize ALL-CAPS to Title case, otherwise just capitalize first letter
    if token.isupper():
        return token[0] + token[1:].lower()
    return token[0].upper() + token[1:]


def main():
    files = [Path(p) for p in sys.argv[1:]]
    if not files:
        sys.exit("Pass one or more scraper JSON files as arguments.")

    sent = load_sent()
    seen_emails = set()
    kept = []
    stats = {"rows": 0, "no_email": 0, "already_sent": 0, "dup": 0,
             "not_houston": 0, "too_big": 0, "venue": 0, "kept": 0}

    for fp in files:
        data = json.loads(fp.read_text())
        for rec in data:
            stats["rows"] += 1
            email = (rec.get("email") or "").strip().lower()
            if not email:
                stats["no_email"] += 1
                continue
            if email in sent:
                stats["already_sent"] += 1
                continue
            if email in seen_emails:
                stats["dup"] += 1
                continue
            text = f"{rec.get('bio','')} {rec.get('display_name','')}"
            if (rec.get("followers") or 0) > MAX_FOLLOWERS:
                stats["too_big"] += 1
                continue
            if not is_houston(text):
                stats["not_houston"] += 1
                continue
            if looks_like_venue(rec, text):
                stats["venue"] += 1
                continue
            seen_emails.add(email)
            kept.append({
                "name": clean_name(rec),
                "email": email,
                "personal_line": "yours stood out",
                "handle": rec.get("handle", ""),
                "followers": rec.get("followers", 0),
            })

    # Sort smallest-to-largest followers (micro creators reply best, go first).
    kept.sort(key=lambda r: r.get("followers", 0))
    stats["kept"] = len(kept)

    OUT_FILE.write_text(json.dumps(kept, indent=2, ensure_ascii=False) + "\n")

    print("=== build-recipients ===")
    for k, v in stats.items():
        print(f"  {k:14} {v}")
    print(f"\nWrote {len(kept)} recipients to {OUT_FILE.name}")
    print("\nName check (greeting -> handle, followers):")
    for r in kept:
        print(f"  Hi {r['name']:<14} @{r['handle']} ({r['followers']:,})")


if __name__ == "__main__":
    main()
