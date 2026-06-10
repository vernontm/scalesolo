#!/usr/bin/env python3
"""
Vernon Tech & Media outreach sender (ray@vernontm.com, Google Workspace).

Mirrors scripts/send-outreach.py (Sanabreh) but for the VernonTM mailbox, and
supports TWO separate campaigns that never share recipients, sent-log, or state:

  --campaign vtm-agency       Cold outreach to small businesses offering
                              website + app builds. Goal: book a call.
  --campaign scalesolo-collab Outreach to AI/SaaS creators to collaborate on
                              ScaleSolo content. Goal: agree to terms, ship posts.

Safety:
  - Password is read ONLY from VERNONTM_EMAIL_PASS (env or gitignored .env).
    Never stored in this file or the recipients data.
  - DRY RUN by default: prints exactly what would be sent, sends nothing.
    Add --send to actually deliver.
  - Each campaign keeps its OWN recipients / sent-log / state files, so the two
    lists never cross-contaminate and reruns never repeat a send.

Usage:
    python3 scripts/send-vernontm-outreach.py --campaign vtm-agency            # dry run
    python3 scripts/send-vernontm-outreach.py --campaign vtm-agency --send --limit 10
    python3 scripts/send-vernontm-outreach.py --campaign scalesolo-collab --test-auth
    python3 scripts/send-vernontm-outreach.py --campaign vtm-agency --check-replies
    python3 scripts/send-vernontm-outreach.py --campaign vtm-agency --followups --send
"""

import argparse
import hashlib
import imaplib
import json
import os
import random
import re
import smtplib
import ssl
import sys
import time
from datetime import datetime
from email.message import EmailMessage
from email.utils import formataddr
from pathlib import Path

# Each campaign carries its OWN mailbox config below (from_email, env_key,
# SMTP/IMAP servers, sent-handling), so the two are completely separate:
#   vtm-agency       -> ray@vernontm.com   (Google Workspace; Gmail auto-files Sent)
#   scalesolo-collab -> ray@scalesolo.ai   (Namecheap Private Email; APPEND to Sent)

SCRIPT_DIR = Path(__file__).parent
ENV_FILE = SCRIPT_DIR.parent / ".env"  # gitignored project-root .env

MAX_TOUCHES = 3            # first email + 2 follow-ups, then stop
FOLLOWUP_AFTER_DAYS = 3    # days to wait before a follow-up is "due"


# =========================================================================
# Campaign definitions. Copy honors VTM voice: plain language, no em dashes,
# no clipped staccato fragments, no contractions. One option per slot is
# chosen deterministically per recipient (seeded by email), so the dry run
# matches the real send and each person reliably gets the same version.
# =========================================================================

VTM_AGENCY = {
    "from_name": "Ray, Vernon Tech & Media",
    "from_email": "ray@vernontm.com",
    "env_key": "VERNONTM_EMAIL_PASS",
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 465,
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    # Gmail auto-saves SMTP sends into "[Gmail]/Sent Mail" server-side, so a
    # manual IMAP APPEND is unnecessary (would duplicate) and fails on the
    # bracketed mailbox name. Skip it for this mailbox.
    "autosaves_sent": True,
    "signoff": "https://vernontm.com\n\nRay\nFounder, Vernon Tech & Media",
    "subjects": [
        "a website and app idea for {first}",
        "quick idea for your business",
        "building your next website (or app)",
        "websites and apps, done faster",
        "a quick idea worth a call",
    ],
    "intro": [
        "I am Ray, the founder of Vernon Tech & Media. We design and build websites and apps for small businesses, and we use AI to do it faster and for a fraction of what an agency normally charges.",
        "I am Ray, founder of Vernon Tech & Media. We build custom websites and apps for small businesses, and because we build with AI we move quickly and keep the cost far below the usual agency price.",
        "My name is Ray and I run Vernon Tech & Media. We help small businesses get a real website or app built, and our AI workflow lets us deliver it faster and cheaper than a traditional agency.",
    ],
    "hook": [
        "I came across your business and {pl}, so I wanted to reach out directly.",
        "I was looking at your business and {pl}, and I thought it was worth a quick note.",
        "Your business caught my eye and {pl}, so I wanted to introduce myself.",
    ],
    "value": [
        "Most owners I talk to are either stuck with a site that does not bring in customers, or they have an app idea they have never been able to afford to build. That is exactly the gap we fill.",
        "A lot of the owners we work with either have a website that looks dated and converts nobody, or an app idea they have sat on for years because the quotes were too high. That is the gap we close.",
        "The owners we help usually fall into one of two camps: a website that is not pulling its weight, or an app idea that always felt out of budget. We were built to handle both.",
    ],
    "close": [
        "If you are open to it, I would love a quick call to learn what you are building and show you what is possible. Reply here and I will send a couple of times.",
        "If you are interested, let us grab a short call so I can hear what you are working on and walk you through some options. Just reply and I will send a few times that work.",
        "If that sounds useful, a quick call is the best next step. Reply and I will send over some times.",
    ],
}

SCALESOLO_COLLAB = {
    "from_name": "Ray, ScaleSolo",
    "from_email": "ray@scalesolo.ai",
    "env_key": "SCALESOLO_EMAIL_PASS",
    "smtp_host": "mail.privateemail.com",
    "smtp_port": 465,
    "imap_host": "mail.privateemail.com",
    "imap_port": 993,
    # Namecheap Private Email does NOT auto-file SMTP sends, so we APPEND each
    # message to the Sent folder over IMAP.
    "autosaves_sent": False,
    "signoff": "Ray\nSocial Outreach Manager, ScaleSolo.ai\nhttps://scalesolo.ai",
    "subjects": [
        "collab idea for {first}",
        "short-form collab with ScaleSolo",
        "want to collab on a ScaleSolo video?",
        "a paid collab opportunity (ScaleSolo)",
        "collab with ScaleSolo.ai",
    ],
    "intro": [
        "I am Ray, the social outreach manager for ScaleSolo.ai. We would love to talk about collaborating with you on a piece of short-form content, one 60 to 90 second video promoting ScaleSolo.",
        "My name is Ray and I run social outreach for ScaleSolo.ai. We are reaching out to collaborate with you on short-form content, specifically a 60 to 90 second video promoting ScaleSolo.",
        "I am Ray, the social outreach manager at ScaleSolo.ai. I wanted to reach out about collaborating with you on a short-form video, around 60 to 90 seconds, promoting ScaleSolo.",
    ],
    "hook": [
        "I came across your content and {pl}, so you were one of the first creators I wanted to reach out to.",
        "Your content has been on my radar and {pl}, which is why I am reaching out directly.",
        "I have been watching your content and {pl}, so I wanted to bring this to you.",
    ],
    # A few sentences on what ScaleSolo is, with the app link.
    "summary": [
        "Here is the short version of what we are. ScaleSolo is an AI platform that lets anyone run a faceless content brand, generating short-form videos end to end without ever being on camera. It is built to help creators and solo founders produce real content at scale without needing a team. You can see it here: https://scalesolo.ai",
        "A quick sense of what we do. ScaleSolo is an AI platform for running a faceless content brand, turning out short-form videos from start to finish with no camera and no editing team. The whole point is helping creators and solo founders make content at scale on their own. You can check it out here: https://scalesolo.ai",
    ],
    # Creative direction is theirs.
    "value": [
        "The creative direction is entirely yours. You can talk about it and showcase the platform, actually use it and show what you created, or take it in whatever direction fits your style. You know your audience far better than we do.",
        "We leave the creative direction completely up to you. Walk through it and showcase the platform, use it and show off what you made with it, or do something else that fits your voice. You know what lands with your audience.",
    ],
    # How the collaboration works (the two phases).
    "phases": [
        "Here is how the collaboration works. Phase one is a single reel that stays up for 30 days while we gauge how the content performs. If the numbers are there, phase two moves into ongoing paid collaborations.",
        "The structure is simple. Phase one is one reel, kept up for 30 days so we can see how it performs. Phase two, assuming the metrics look good, is where we move into paid collaborations.",
    ],
    # The offer that applies to both phases (affiliate + credits).
    "perks": [
        "In both phases you also get a strong affiliate deal, 30 percent of the recurring revenue from anyone who subscribes through you, for as long as they stay. On top of that we will load you up with free video credits and AI credits so you can use the platform yourself.",
        "Either way, you get a generous affiliate split in both phases, 30 percent of the recurring revenue from everyone who signs up through your link, for as long as they remain a member. We will also hand you free video credits and AI credits so you can put ScaleSolo to work yourself.",
    ],
    "close": [
        "If this sounds like something you would be into, reply and we will get you set up and lock in the details.",
        "If you are interested, just reply and I will get you everything you need to get started.",
        "If you are open to it, reply and we will sort out the details and get you going.",
    ],
}

# Website-rebuild pitch. Same mailbox as vtm-agency (ray@vernontm.com) but
# tracked separately. Every recipient carries its own "custom_body" (the full
# bespoke email, greeting through signoff) and "subject", so the template
# sections below are only fallbacks.
VTM_REBUILD = {
    "from_name": "Ray, Vernon Tech & Media",
    "from_email": "ray@vernontm.com",
    "env_key": "VERNONTM_EMAIL_PASS",
    "smtp_host": "smtp.gmail.com",
    "smtp_port": 465,
    "imap_host": "imap.gmail.com",
    "imap_port": 993,
    "autosaves_sent": True,
    "signoff": "https://vernontm.com\n\nRay\nFounder, Vernon Tech & Media",
    "subjects": ["a website redesign concept for you"],
    "intro": ["I am Ray, the founder of Vernon Tech & Media."],
    "hook": ["I came across your business and {pl}."],
    "value": ["We build modern websites and apps for small businesses."],
    "close": ["If you like it, just reply and we can talk."],
}

CAMPAIGNS = {
    "vtm-agency": VTM_AGENCY,
    "scalesolo-collab": SCALESOLO_COLLAB,
    "vtm-rebuild": VTM_REBUILD,
}

# Light follow-up bodies, per campaign. {name} -> greeting.
FOLLOWUPS = {
    "vtm-agency": {
        2: (
            "Hi {name},\n\n"
            "Floating this back up in case it got buried. The offer stands: a quick call to talk "
            "through your website or app, no obligation. If now is not the time, no problem at all.\n\n"
            "If you are open to it, reply and I will send a couple of times.\n\n"
            "https://vernontm.com\n\nRay\nFounder, Vernon Tech & Media\n"
        ),
        3: (
            "Hi {name},\n\n"
            "Last note from me so I am not cluttering your inbox. If a faster, more affordable way to "
            "build your website or app is ever useful, the door is open.\n\n"
            "Reply any time and we will set up a quick call.\n\n"
            "https://vernontm.com\n\nRay\nFounder, Vernon Tech & Media\n"
        ),
    },
    "scalesolo-collab": {
        2: (
            "Hi {name},\n\n"
            "Floating this back up in case it slipped by. The collab offer still stands: one 60 to 90 "
            "second video on ScaleSolo, full creative freedom, a 30 percent recurring affiliate split, "
            "and free video and AI credits to use the platform yourself.\n\n"
            "If you are open to it, reply and I will get you set up.\n\n"
            "Ray\nSocial Outreach Manager, ScaleSolo.ai\nhttps://scalesolo.ai\n"
        ),
        3: (
            "Hi {name},\n\n"
            "Last note from me so I am not cluttering your inbox. If collaborating with ScaleSolo ever "
            "sounds good, the door is open. Full creative control, a strong recurring affiliate split, "
            "and free credits to use the platform.\n\n"
            "Reply any time and I will get you going.\n\n"
            "Ray\nSocial Outreach Manager, ScaleSolo.ai\nhttps://scalesolo.ai\n"
        ),
    },
    "vtm-rebuild": {
        2: (
            "Hi {name},\n\n"
            "Just floating this back up. I put together a redesign concept of your website "
            "last week and wanted to make sure it reached you. No cost and no obligation, it is "
            "yours to look at.\n\n"
            "If you like the direction, reply and we can talk about making it your real site.\n\n"
            "https://vernontm.com\n\nRay\nFounder, Vernon Tech & Media\n"
        ),
        3: (
            "Hi {name},\n\n"
            "Last note from me so I am not cluttering your inbox. The redesign concept I built for "
            "you is still up if you want to take a look. If a modern, faster website is ever useful, "
            "the door is open.\n\n"
            "Reply any time and we can pick it up from there.\n\n"
            "https://vernontm.com\n\nRay\nFounder, Vernon Tech & Media\n"
        ),
    },
}


# --- helpers -------------------------------------------------------------

def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def days_since(iso):
    try:
        return (datetime.now() - datetime.fromisoformat(iso)).total_seconds() / 86400.0
    except Exception:
        return 9999.0


def get_password(env_key):
    pw = os.environ.get(env_key)
    if pw:
        return pw
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key.strip() == env_key:
                return val.strip().strip('"').strip("'")
    return None


def _rng_for(email):
    seed = int(hashlib.sha256(email.lower().encode()).hexdigest(), 16) % (2**32)
    return random.Random(seed)


def first_name(name):
    n = (name or "").strip()
    if n.lower() in ("there", "team", ""):
        return "you"
    return n.split()[0]


# --- per-campaign file paths --------------------------------------------

class Campaign:
    def __init__(self, key):
        if key not in CAMPAIGNS:
            sys.exit(f"Unknown campaign '{key}'. Choose from: {', '.join(CAMPAIGNS)}")
        self.key = key
        self.cfg = CAMPAIGNS[key]
        self.from_name = self.cfg["from_name"]
        self.from_email = self.cfg["from_email"]
        self.env_key = self.cfg["env_key"]
        self.smtp_host = self.cfg["smtp_host"]
        self.smtp_port = self.cfg["smtp_port"]
        self.imap_host = self.cfg["imap_host"]
        self.imap_port = self.cfg["imap_port"]
        self.autosaves_sent = self.cfg["autosaves_sent"]
        self.recipients_file = SCRIPT_DIR / f"vtm-{key}-recipients.json"
        self.sent_log = SCRIPT_DIR / f"vtm-{key}-sent-log.txt"
        self.state_file = SCRIPT_DIR / f"vtm-{key}-state.json"

    # --- state / log ---
    def load_state(self):
        if self.state_file.exists():
            try:
                return json.loads(self.state_file.read_text())
            except Exception:
                return {}
        return {}

    def save_state(self, state):
        self.state_file.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")

    def load_sent(self):
        sent = set()
        if self.sent_log.exists():
            for line in self.sent_log.read_text().splitlines():
                line = line.strip().lower()
                if line and not line.startswith("#"):
                    sent.add(line)
        return sent

    def append_sent(self, email):
        with open(self.sent_log, "a") as f:
            f.write(email.lower() + "\n")

    def load_recipients(self):
        if not self.recipients_file.exists():
            sys.exit(
                f"Recipients file not found: {self.recipients_file}\n"
                f"Create it as a JSON array of {{name, email, personal_line}} objects."
            )
        with open(self.recipients_file) as f:
            data = json.load(f)
        if not isinstance(data, list):
            sys.exit("Recipients file must be a JSON array.")
        for i, r in enumerate(data):
            # personal_line is only needed for template-rendered campaigns;
            # recipients carrying a full custom_body do not use it.
            required = ("name", "email") if r.get("custom_body") else ("name", "email", "personal_line")
            for key in required:
                if not r.get(key):
                    sys.exit(f"Recipient #{i + 1} is missing required field: {key}")
        return data

    # --- rendering ---
    def render_subject(self, r, rng):
        if r.get("subject"):
            return r["subject"]
        return rng.choice(self.cfg["subjects"]).format(first=first_name(r["name"]))

    # Body sections, in order. A campaign only needs to define the ones it
    # uses; missing keys are skipped. Each value is a list of phrasings (one is
    # chosen deterministically per recipient) or a single string.
    BODY_SECTIONS = ("intro", "hook", "summary", "value", "phases", "perks", "close")

    def render_body(self, r, rng):
        greeting = (
            f"Hi {r['name']},"
            if r["name"].strip().lower() not in ("there", "team")
            else "Hi there,"
        )
        paras = [greeting]
        for key in self.BODY_SECTIONS:
            section = self.cfg.get(key)
            if not section:
                continue
            chosen = rng.choice(section) if isinstance(section, list) else section
            paras.append(chosen.format(pl=r.get("personal_line", ""), first=first_name(r["name"])))
        paras.append(self.cfg["signoff"])
        return "\n\n".join(paras) + "\n"

    def build_message(self, r):
        rng = _rng_for(r["email"])
        msg = EmailMessage()
        msg["From"] = formataddr((self.from_name, self.from_email))
        to_name = "" if r["name"].strip().lower() in ("there", "team") else r["name"]
        msg["To"] = formataddr((to_name, r["email"]))
        msg["Subject"] = self.render_subject(r, rng)
        msg["Reply-To"] = self.from_email
        # A recipient may supply a complete bespoke body (greeting -> signoff);
        # otherwise we render from the campaign's template sections.
        msg.set_content(r["custom_body"] if r.get("custom_body") else self.render_body(r, rng))
        return msg

    def build_followup_message(self, r, touch, subject):
        msg = EmailMessage()
        msg["From"] = formataddr((self.from_name, self.from_email))
        to_name = "" if r["name"].strip().lower() in ("there", "team") else r["name"]
        msg["To"] = formataddr((to_name, r["email"]))
        msg["Subject"] = subject
        msg["Reply-To"] = self.from_email
        name = r["name"] if r["name"].strip().lower() not in ("there", "team") else "there"
        msg.set_content(FOLLOWUPS[self.key][touch].format(name=name))
        return msg


# --- SMTP / IMAP plumbing (shared) ---------------------------------------

def make_ssl_context():
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\)\s+(?P<delim>"[^"]*"|NIL)\s+(?P<name>.+)$')


def _parse_list_line(raw):
    line = raw.decode(errors="replace") if isinstance(raw, bytes) else raw
    m = _LIST_RE.match(line.strip())
    if not m:
        return None, None
    name = m.group("name").strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1]
    return m.group("flags"), name


def find_sent_folder(imap):
    typ, data = imap.list()
    if typ != "OK" or not data:
        return None
    parsed = [_parse_list_line(raw) for raw in data]
    for flags, name in parsed:
        if name and flags and "\\Sent" in flags:
            return name
    present = {name for _, name in parsed if name}
    for candidate in ("[Gmail]/Sent Mail", "Sent", "Sent Items"):
        if candidate in present:
            return candidate
    return None


def open_sent_mailbox(camp, password):
    # Mailboxes that auto-file SMTP sends (Gmail) skip the manual APPEND, which
    # would duplicate and fails on the bracketed "[Gmail]/Sent Mail" name.
    if camp.autosaves_sent:
        return None, None
    try:
        context = make_ssl_context()
        imap = imaplib.IMAP4_SSL(camp.imap_host, camp.imap_port, ssl_context=context)
        imap.login(camp.from_email, password)
        folder = find_sent_folder(imap)
        if not folder:
            print("  (could not locate a Sent folder; copies will not be saved)")
            imap.logout()
            return None, None
        return imap, folder
    except Exception as e:
        print(f"  (IMAP connect failed, copies will not be saved: {e})")
        return None, None


def append_to_sent(imap, folder, msg):
    if not imap or not folder:
        return False
    try:
        imap.append(folder, "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        return True
    except Exception as e:
        print(f"  (save-to-Sent failed for {msg['To']}: {e})")
        return False


def reconcile_state_from_log(camp, state):
    by_email = {r["email"].lower(): r for r in camp.load_recipients()}
    for email in camp.load_sent():
        if email not in state:
            r = by_email.get(email, {})
            state[email] = {
                "email": email,
                "name": r.get("name", ""),
                "handle": r.get("handle", ""),
                "first_sent": now_iso(),
                "last_sent": now_iso(),
                "touches": 1,
                "subject": "",
                "replied": False,
                "replied_at": None,
            }
    return state


def check_replies(camp, password):
    state = reconcile_state_from_log(camp, camp.load_state())
    pending = [e for e, s in state.items() if not s.get("replied")]
    if not pending:
        camp.save_state(state)
        return 0
    newly = 0
    try:
        context = make_ssl_context()
        with imaplib.IMAP4_SSL(camp.imap_host, camp.imap_port, ssl_context=context) as imap:
            imap.login(camp.from_email, password)
            imap.select("INBOX")
            for email in pending:
                try:
                    typ, data = imap.search(None, "FROM", f'"{email}"')
                    if typ == "OK" and data and data[0].split():
                        state[email]["replied"] = True
                        state[email]["replied_at"] = now_iso()
                        newly += 1
                except Exception:
                    continue
    except Exception as e:
        print(f"  (reply check failed: {e})")
    camp.save_state(state)
    return newly


def due_followups(state):
    due = []
    for email, s in state.items():
        if s.get("replied"):
            continue
        if s.get("touches", 0) >= MAX_TOUCHES:
            continue
        if days_since(s.get("last_sent", "")) >= FOLLOWUP_AFTER_DAYS:
            due.append(email)
    return due


def main():
    parser = argparse.ArgumentParser(description="Send VernonTM outreach emails.")
    parser.add_argument("--campaign", required=True, choices=list(CAMPAIGNS),
                        help="Which campaign to run (vtm-agency or scalesolo-collab).")
    parser.add_argument("--send", action="store_true", help="Actually send (default is dry run).")
    parser.add_argument("--only", help="Only send to recipients whose name contains this string.")
    parser.add_argument("--limit", type=int, default=None, help="Max emails to send this run.")
    parser.add_argument("--delay-min", type=float, default=35.0, help="Min seconds between sends.")
    parser.add_argument("--delay-max", type=float, default=75.0, help="Max seconds between sends.")
    parser.add_argument("--test-auth", action="store_true", help="Only test SMTP login, send nothing.")
    parser.add_argument("--no-save-sent", action="store_true", help="Do not save copies to IMAP Sent.")
    parser.add_argument("--check-replies", action="store_true",
                        help="Scan INBOX and mark contacted leads that have replied. Sends nothing.")
    parser.add_argument("--followups", action="store_true",
                        help="Send follow-ups to leads due (no reply, <3 touches, 3+ days since last).")
    args = parser.parse_args()

    camp = Campaign(args.campaign)

    if args.test_auth:
        password = get_password(camp.env_key)
        if not password:
            sys.exit(f"No password found. Set {camp.env_key} in .env or the environment.")
        context = make_ssl_context()
        print(f"Testing login as {camp.from_email} @ {camp.smtp_host}:{camp.smtp_port} ...")
        try:
            with smtplib.SMTP_SSL(camp.smtp_host, camp.smtp_port, context=context) as server:
                server.login(camp.from_email, password)
            print("SUCCESS: credentials accepted.")
        except smtplib.SMTPAuthenticationError as e:
            print(f"AUTH FAILED: {e.smtp_code} {e.smtp_error.decode(errors='replace')}")
            sys.exit(1)
        return

    if args.check_replies:
        password = get_password(camp.env_key)
        if not password:
            sys.exit(f"No password found. Set {camp.env_key} in .env or the environment.")
        n = check_replies(camp, password)
        print(f"[{camp.key}] Reply check complete. Newly marked as replied: {n}")
        return

    if args.followups:
        password = get_password(camp.env_key)
        if not password:
            sys.exit(f"No password found. Set {camp.env_key} in .env or the environment.")
        check_replies(camp, password)  # never follow up someone who answered
        state = reconcile_state_from_log(camp, camp.load_state())
        by_email = {r["email"].lower(): r for r in camp.load_recipients()}
        due = [e for e in due_followups(state) if e in by_email]
        if args.limit is not None:
            due = due[: args.limit]
        mode = "SEND" if args.send else "DRY RUN"
        print(f"=== {camp.key} follow-ups :: {mode} ===")
        print(f"Due for follow-up: {len(due)}\n")
        if not due:
            print("No follow-ups due right now.")
            return
        if not args.send:
            for e in due:
                s = state[e]
                print(f"  touch {s['touches'] + 1} -> {e} (last {days_since(s['last_sent']):.1f}d ago)")
            print("\nDRY RUN. Re-run with --send to deliver follow-ups.")
            return
        context = make_ssl_context()
        imap, folder = (None, None) if args.no_save_sent else open_sent_mailbox(camp, password)
        sent_n, failed = 0, []
        try:
            with smtplib.SMTP_SSL(camp.smtp_host, camp.smtp_port, context=context) as server:
                server.login(camp.from_email, password)
                for i, e in enumerate(due):
                    s = state[e]
                    touch = s["touches"] + 1
                    r = by_email[e]
                    msg = camp.build_followup_message(r, touch, s.get("subject") or camp.build_message(r)["Subject"])
                    try:
                        server.send_message(msg)
                        s["touches"] = touch
                        s["last_sent"] = now_iso()
                        camp.save_state(state)
                        append_to_sent(imap, folder, msg)
                        print(f"  [{i + 1}/{len(due)}] follow-up #{touch - 1} -> {e}")
                        sent_n += 1
                    except Exception as ex:
                        failed.append((e, str(ex)))
                        print(f"  [{i + 1}/{len(due)}] FAILED -> {e}: {ex}")
                    if i < len(due) - 1:
                        time.sleep(random.uniform(args.delay_min, args.delay_max))
        finally:
            if imap:
                try:
                    imap.logout()
                except Exception:
                    pass
        print(f"\nDone. Follow-ups sent: {sent_n}. Failed: {len(failed)}.")
        return

    recipients = camp.load_recipients()
    if args.only:
        recipients = [r for r in recipients if args.only.lower() in r["name"].lower()]
        if not recipients:
            sys.exit(f"No recipients matched --only '{args.only}'.")

    sent_set = camp.load_sent()
    total_after_only = len(recipients)
    recipients = [r for r in recipients if r["email"].lower() not in sent_set]
    skipped = total_after_only - len(recipients)
    remaining = len(recipients)
    if args.limit is not None:
        recipients = recipients[: args.limit]

    mode = "SEND" if args.send else "DRY RUN"
    print(f"=== VernonTM outreach [{camp.key}] :: {mode} ===")
    print(f"From: {formataddr((camp.from_name, camp.from_email))}")
    print(f"Already contacted (skipped): {skipped}")
    print(f"Remaining not-yet-contacted: {remaining}")
    print(f"Sending this run: {len(recipients)}"
          + (f" (capped by --limit {args.limit})" if args.limit is not None and remaining > args.limit else "")
          + "\n")
    if not recipients:
        print("Nothing to send. Everyone in the list has already been contacted.")
        return

    if not args.send:
        for i, r in enumerate(recipients):
            msg = camp.build_message(r)
            print(f"  [{i + 1:>2}] {msg['Subject']:<42} -> {msg['To']}")
        sample = camp.build_message(recipients[0])
        print("\n----- sample (first recipient) -----")
        print(f"To:      {sample['To']}")
        print(f"Subject: {sample['Subject']}\n")
        print(sample.get_content())
        print("------------------------------------")
        print("\nDRY RUN complete. No emails were sent.")
        print("Re-run with --send to deliver.")
        return

    password = get_password(camp.env_key)
    if not password:
        sys.exit(
            f"No password found.\nAdd to the gitignored .env at the project root:\n"
            f"    {camp.env_key}=your-app-password\n"
            f"or run:  export {camp.env_key}='your-app-password'"
        )

    context = make_ssl_context()
    sent, failed = 0, []
    state = camp.load_state()
    imap, folder = (None, None)
    if not args.no_save_sent:
        imap, folder = open_sent_mailbox(camp, password)

    print("Connecting to SMTP server...")
    try:
        with smtplib.SMTP_SSL(camp.smtp_host, camp.smtp_port, context=context) as server:
            server.login(camp.from_email, password)
            print("Logged in. Sending...\n")
            for i, r in enumerate(recipients):
                msg = camp.build_message(r)
                try:
                    server.send_message(msg)
                    sent += 1
                    camp.append_sent(r["email"])
                    state[r["email"].lower()] = {
                        "email": r["email"].lower(),
                        "name": r.get("name", ""),
                        "handle": r.get("handle", ""),
                        "first_sent": now_iso(),
                        "last_sent": now_iso(),
                        "touches": 1,
                        "subject": msg["Subject"],
                        "replied": False,
                        "replied_at": None,
                    }
                    camp.save_state(state)
                    saved = append_to_sent(imap, folder, msg)
                    tag = "sent+filed" if saved else "sent"
                    print(f"  [{i + 1}/{len(recipients)}] {tag} -> {r['email']}")
                except Exception as e:
                    failed.append((r["email"], str(e)))
                    print(f"  [{i + 1}/{len(recipients)}] FAILED -> {r['email']}: {e}")
                if i < len(recipients) - 1:
                    wait = random.uniform(args.delay_min, args.delay_max)
                    print(f"      (waiting {wait:.0f}s)")
                    time.sleep(wait)
    finally:
        if imap:
            try:
                imap.logout()
            except Exception:
                pass

    print(f"\nDone. Sent: {sent}. Failed: {len(failed)}.")
    for email, err in failed:
        print(f"  FAILED {email}: {err}")


if __name__ == "__main__":
    main()
