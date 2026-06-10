#!/usr/bin/env python3
"""
Sanabreh influencer outreach sender.

Sends personalized cold-outreach emails over SMTP (SSL, port 465).

Safety:
  - Password is read ONLY from the SANABREH_EMAIL_PASS environment variable.
    It is never stored in this file or in the recipients data.
  - Runs in DRY-RUN by default: prints exactly what would be sent, sends nothing.
    Add --send to actually deliver.

Usage:
    export SANABREH_EMAIL_PASS='your-password-here'
    python3 scripts/send-outreach.py                 # dry run (no email sent)
    python3 scripts/send-outreach.py --send          # actually send
    python3 scripts/send-outreach.py --send --only "Maya"   # send to one person

Recipients live in scripts/outreach-recipients.json.
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

# --- Account / server config ---------------------------------------------
SMTP_HOST = "mail.sanabrehrestaurant.com"
SMTP_PORT = 465  # SSL
IMAP_HOST = "mail.sanabrehrestaurant.com"
IMAP_PORT = 993  # SSL
FROM_EMAIL = "info@sanabrehrestaurant.com"
FROM_NAME = "Ray, Sanabreh"

RECIPIENTS_FILE = Path(__file__).parent / "outreach-recipients.json"
SENT_LOG = Path(__file__).parent / "outreach-sent-log.txt"
STATE_FILE = Path(__file__).parent / "outreach-state.json"

MAX_TOUCHES = 3            # first email + 2 follow-ups, then stop
FOLLOWUP_AFTER_DAYS = 3    # days to wait before a follow-up is "due"


def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def load_state():
    if STATE_FILE.exists():
        try:
            return json.loads(STATE_FILE.read_text())
        except Exception:
            return {}
    return {}


def save_state(state):
    STATE_FILE.write_text(json.dumps(state, indent=2, ensure_ascii=False) + "\n")


def days_since(iso):
    try:
        return (datetime.now() - datetime.fromisoformat(iso)).total_seconds() / 86400.0
    except Exception:
        return 9999.0

# .env lives at the project root and is gitignored (never committed/pushed).
ENV_FILE = Path(__file__).parent.parent / ".env"


def load_sent():
    sent = set()
    if SENT_LOG.exists():
        for line in SENT_LOG.read_text().splitlines():
            line = line.strip().lower()
            if line and not line.startswith("#"):
                sent.add(line)
    return sent


def append_sent(email):
    with open(SENT_LOG, "a") as f:
        f.write(email.lower() + "\n")


def get_password():
    """Read the SMTP password from the environment, falling back to the
    gitignored project-root .env file. Returns None if not found."""
    pw = os.environ.get("SANABREH_EMAIL_PASS")
    if pw:
        return pw
    if ENV_FILE.exists():
        for line in ENV_FILE.read_text().splitlines():
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, val = line.partition("=")
            if key.strip() == "SANABREH_EMAIL_PASS":
                return val.strip().strip('"').strip("'")
    return None

# Subject variants. All keep the lowercase "re:" style so they read like an
# ongoing thread. Rotating them (plus the body variants below) keeps the batch
# from looking like one identical mass-send to spam filters.
SUBJECT_VARIANTS = [
    "re: influencer collaboration inquiry",
    "re: collab with a local houston spot",
    "re: quick collab idea",
    "re: content collab (houston)",
    "re: working together",
    "re: a collab idea for you",
]
DEFAULT_SUBJECT = SUBJECT_VARIANTS[0]

# Body phrasing variants. One option per slot is chosen deterministically per
# recipient (seeded by their email), so the dry run matches the real send and
# each person reliably gets the same version. No em dashes anywhere.
_INTRO = [
    "I'm Ray, Outreach Manager for Sanabreh, a Mediterranean restaurant here in Houston.",
    "I'm Ray, I run outreach for Sanabreh, a Mediterranean restaurant here in Houston.",
    "My name is Ray and I handle outreach for Sanabreh, a Mediterranean restaurant in Houston.",
]
_HOOK = [
    "We're looking to team up with local creators on short-form content, and {pl}.",
    "We're teaming up with a few local creators on short-form content, and {pl}.",
    "We want to work with local creators on short-form content, and {pl}.",
]
_PHASE1 = [
    "Here's how we usually work: Phase 1, the tryout. Come in as our guest for a free meal and shoot whatever feels natural. We watch how it performs over the next 30 days, no pressure.",
    "Here's how it normally goes. Phase 1 is the tryout: come in as our guest for a free meal and film whatever feels natural. We see how it does over the next 30 days, no pressure.",
    "The way it works: Phase 1 is a tryout. You come in on us for a free meal and shoot whatever feels right, then we watch how it performs over 30 days, no pressure.",
]
_PHASE2 = [
    "Phase 2, the real deal. If the numbers are there, we talk a fair rate for your time, plus perks like food and hookah deals, and first dibs on hosting events in our space. We're a hidden gem still fighting for more eyes, and we think your audience would love us.",
    "Phase 2 is the real deal. If the numbers show up, we work out a fair rate for your time, plus food and hookah perks and first dibs on hosting events with us. We're a hidden gem still fighting for more eyes, and your audience would love this place.",
    "Then Phase 2, the real deal. If it performs, we discuss a fair rate for your time, plus perks like food and hookah deals and first dibs on hosting events in our space. We're a bit of a hidden gem still fighting for more eyes, and we think your people would love us.",
]
_CLOSE = [
    "If you're in, reply and we'll set up a time.",
    "If that sounds good, just reply and we'll find a time.",
    "If you're interested, reply and we'll get a time on the calendar.",
]
_SIGNOFF = "https://sanabrehrestaurant.com\n\nRay\nOutreach Manager, Sanabreh"


def _rng_for(email):
    seed = int(hashlib.sha256(email.lower().encode()).hexdigest(), 16) % (2**32)
    return random.Random(seed)


def render_subject(r, rng):
    # explicit per-recipient subject wins; otherwise rotate the variants
    return r.get("subject") or rng.choice(SUBJECT_VARIANTS)


def render_body(r, rng):
    para2 = rng.choice(_INTRO) + " " + rng.choice(_HOOK).format(pl=r["personal_line"])
    paras = [
        f"Hi {r['name']},",
        para2,
        rng.choice(_PHASE1),
        rng.choice(_PHASE2),
        rng.choice(_CLOSE),
        _SIGNOFF,
    ]
    return "\n\n".join(paras) + "\n"


# Follow-up bodies. Touch 2 is a light bump, touch 3 is a final note. Short on
# purpose. No em dashes. {name} -> greeting.
_FOLLOWUP = {
    2: (
        "Hi {name},\n\n"
        "Just floating this back up in case it got buried. The offer still stands: "
        "come by Sanabreh as our guest, bring someone, and shoot whatever feels natural. "
        "No pressure at all.\n\n"
        "If you're open to it, reply and we'll find a time.\n\n"
        "https://sanabrehrestaurant.com\n\n"
        "Ray\nOutreach Manager, Sanabreh\n"
    ),
    3: (
        "Hi {name},\n\n"
        "Last note from me, I don't want to clutter your inbox. We'd still love to host you "
        "at Sanabreh for a meal on us in exchange for a quick video. The door is open whenever "
        "you are.\n\n"
        "Reply any time and we'll set it up.\n\n"
        "https://sanabrehrestaurant.com\n\n"
        "Ray\nOutreach Manager, Sanabreh\n"
    ),
}


def build_followup_message(r, touch, subject):
    msg = EmailMessage()
    msg["From"] = formataddr((FROM_NAME, FROM_EMAIL))
    to_name = "" if r["name"].strip().lower() in ("there", "team") else r["name"]
    msg["To"] = formataddr((to_name, r["email"]))
    msg["Subject"] = subject  # reuse first subject so it reads like the same thread
    msg["Reply-To"] = FROM_EMAIL
    msg.set_content(_FOLLOWUP[touch].format(name=r["name"]))
    return msg


def load_recipients():
    if not RECIPIENTS_FILE.exists():
        sys.exit(f"Recipients file not found: {RECIPIENTS_FILE}")
    with open(RECIPIENTS_FILE) as f:
        data = json.load(f)
    if not isinstance(data, list) or not data:
        sys.exit("Recipients file must be a non-empty JSON array.")
    for i, r in enumerate(data):
        for key in ("name", "email", "personal_line"):
            if not r.get(key):
                sys.exit(f"Recipient #{i + 1} is missing required field: {key}")
    return data


def build_message(r):
    rng = _rng_for(r["email"])
    msg = EmailMessage()
    msg["From"] = formataddr((FROM_NAME, FROM_EMAIL))
    # Only use the name as a display name when it's a real name, not a generic
    # greeting like "there" (used for brand/anonymous handles).
    to_name = "" if r["name"].strip().lower() in ("there", "team") else r["name"]
    msg["To"] = formataddr((to_name, r["email"]))
    msg["Subject"] = render_subject(r, rng)
    msg["Reply-To"] = FROM_EMAIL
    msg.set_content(render_body(r, rng))
    return msg


def make_ssl_context():
    """python.org's macOS Python ships without a CA store, so fall back to
    certifi's bundle when available to avoid CERTIFICATE_VERIFY_FAILED."""
    try:
        import certifi
        return ssl.create_default_context(cafile=certifi.where())
    except ImportError:
        return ssl.create_default_context()


_LIST_RE = re.compile(r'^\((?P<flags>[^)]*)\)\s+(?P<delim>"[^"]*"|NIL)\s+(?P<name>.+)$')


def _parse_list_line(raw):
    """Parse one IMAP LIST response line into (flags_str, mailbox_name).
    Handles both quoted and unquoted mailbox names. Returns (None, None) on
    no match."""
    line = raw.decode(errors="replace") if isinstance(raw, bytes) else raw
    m = _LIST_RE.match(line.strip())
    if not m:
        return None, None
    name = m.group("name").strip()
    if name.startswith('"') and name.endswith('"'):
        name = name[1:-1]
    return m.group("flags"), name


def find_sent_folder(imap):
    """Locate the Sent folder, preferring the IMAP \\Sent special-use flag,
    then common names. Returns the mailbox name to APPEND into, or None."""
    typ, data = imap.list()
    if typ != "OK" or not data:
        return None
    parsed = [_parse_list_line(raw) for raw in data]
    # First pass: special-use \Sent flag.
    for flags, name in parsed:
        if name and flags and "\\Sent" in flags:
            return name
    # Second pass: common names actually present on the server.
    present = {name for _, name in parsed if name}
    for candidate in ("Sent", "INBOX.Sent", "Sent Items", "INBOX.Sent Items"):
        if candidate in present:
            return candidate
    return None


def open_sent_mailbox(password):
    """Open an IMAP connection and locate the Sent folder. Returns
    (imap, folder) or (None, None) on failure. Caller logs out."""
    try:
        context = make_ssl_context()
        imap = imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=context)
        imap.login(FROM_EMAIL, password)
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
    """Append one message to the Sent folder. Best effort, never raises."""
    if not imap or not folder:
        return False
    try:
        imap.append(folder, "\\Seen", imaplib.Time2Internaldate(time.time()), msg.as_bytes())
        return True
    except Exception as e:
        print(f"  (save-to-Sent failed for {msg['To']}: {e})")
        return False


def reconcile_state_from_log(state):
    """Ensure every contacted email (sent-log) has a state entry. Seeds missing
    ones from recipients.json with the current time (self-healing for sends made
    before state tracking existed). Returns the state dict."""
    by_email = {r["email"].lower(): r for r in load_recipients()}
    for email in load_sent():
        if email not in state:
            r = by_email.get(email, {})
            state[email] = {
                "email": email,
                "name": r.get("name", ""),
                "handle": r.get("handle", ""),
                "followers": r.get("followers", 0),
                "first_sent": now_iso(),
                "last_sent": now_iso(),
                "touches": 1,
                "subject": DEFAULT_SUBJECT,
                "replied": False,
                "replied_at": None,
            }
    return state


def check_replies(password):
    """Scan the INBOX for messages from contacted leads and mark them replied
    in state. Returns the number newly marked as replied."""
    state = reconcile_state_from_log(load_state())
    pending = [e for e, s in state.items() if not s.get("replied")]
    if not pending:
        save_state(state)
        return 0
    newly = 0
    try:
        context = make_ssl_context()
        with imaplib.IMAP4_SSL(IMAP_HOST, IMAP_PORT, ssl_context=context) as imap:
            imap.login(FROM_EMAIL, password)
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
    save_state(state)
    return newly


def due_followups(state):
    """Return list of emails due for a follow-up: contacted, not replied,
    fewer than MAX_TOUCHES touches, and last touch >= FOLLOWUP_AFTER_DAYS ago."""
    due = []
    for email, s in state.items():
        if s.get("replied"):
            continue
        if s.get("touches", 0) >= MAX_TOUCHES:
            continue
        if days_since(s.get("last_sent", "")) >= FOLLOWUP_AFTER_DAYS:
            due.append(email)
    # smallest follower counts first (best replyers)
    due.sort(key=lambda e: state[e].get("followers", 0))
    return due


def main():
    parser = argparse.ArgumentParser(description="Send Sanabreh outreach emails.")
    parser.add_argument("--send", action="store_true", help="Actually send (default is dry run).")
    parser.add_argument("--only", help="Only send to recipients whose name contains this string.")
    parser.add_argument("--limit", type=int, default=None, help="Max emails to send this run (daily batch size).")
    parser.add_argument("--delay-min", type=float, default=35.0, help="Min seconds between sends (default 35).")
    parser.add_argument("--delay-max", type=float, default=75.0, help="Max seconds between sends (default 75).")
    parser.add_argument("--test-auth", action="store_true", help="Only test SMTP login, send nothing.")
    parser.add_argument("--no-save-sent", action="store_true", help="Do not save copies to the IMAP Sent folder.")
    parser.add_argument("--backfill-sent", action="store_true",
                        help="Append Sent copies for recipients already in the sent-log (no emails sent). One-time recovery.")
    parser.add_argument("--check-replies", action="store_true",
                        help="Scan INBOX and mark contacted leads that have replied. Sends nothing.")
    parser.add_argument("--followups", action="store_true",
                        help="Send follow-ups to leads due (no reply, fewer than 3 touches, 3+ days since last).")
    args = parser.parse_args()

    if args.check_replies:
        password = get_password()
        if not password:
            sys.exit("No password found in .env or environment.")
        n = check_replies(password)
        print(f"Reply check complete. Newly marked as replied: {n}")
        return

    if args.followups:
        password = get_password()
        if not password:
            sys.exit("No password found in .env or environment.")
        # always refresh replies first so we never follow up someone who answered
        check_replies(password)
        state = reconcile_state_from_log(load_state())
        by_email = {r["email"].lower(): r for r in load_recipients()}
        due = [e for e in due_followups(state) if e in by_email]
        if args.limit is not None:
            due = due[: args.limit]
        mode = "SEND" if args.send else "DRY RUN"
        print(f"=== Sanabreh follow-ups :: {mode} ===")
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
        imap, folder = (None, None) if args.no_save_sent else open_sent_mailbox(password)
        sent_n, failed = 0, []
        try:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
                server.login(FROM_EMAIL, password)
                for i, e in enumerate(due):
                    s = state[e]
                    touch = s["touches"] + 1
                    r = by_email[e]
                    msg = build_followup_message(r, touch, s.get("subject", DEFAULT_SUBJECT))
                    try:
                        server.send_message(msg)
                        s["touches"] = touch
                        s["last_sent"] = now_iso()
                        save_state(state)
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

    if args.backfill_sent:
        password = get_password()
        if not password:
            sys.exit("No password found in .env or environment.")
        sent_set = load_sent()
        targets = [r for r in load_recipients() if r["email"].lower() in sent_set]
        print(f"Backfilling Sent copies for {len(targets)} already-contacted recipients...")
        imap, folder = open_sent_mailbox(password)
        if not imap:
            sys.exit("Could not open Sent mailbox.")
        saved = 0
        for r in targets:
            if append_to_sent(imap, folder, build_message(r)):
                saved += 1
                print(f"  filed -> {r['email']}")
        imap.logout()
        print(f"\nDone. Filed {saved} copies into '{folder}'.")
        return

    if args.test_auth:
        password = get_password()
        if not password:
            sys.exit("No password found in .env or environment.")
        context = make_ssl_context()
        print(f"Testing login as {FROM_EMAIL} @ {SMTP_HOST}:{SMTP_PORT} ...")
        try:
            with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
                server.login(FROM_EMAIL, password)
            print("SUCCESS: credentials accepted.")
        except smtplib.SMTPAuthenticationError as e:
            print(f"AUTH FAILED: {e.smtp_code} {e.smtp_error.decode(errors='replace')}")
            sys.exit(1)
        return

    recipients = load_recipients()
    if args.only:
        recipients = [r for r in recipients if args.only.lower() in r["name"].lower()]
        if not recipients:
            sys.exit(f"No recipients matched --only '{args.only}'.")

    # Skip anyone already contacted (sent-log), so daily batches never repeat.
    sent_set = load_sent()
    total_after_only = len(recipients)
    recipients = [r for r in recipients if r["email"].lower() not in sent_set]
    skipped = total_after_only - len(recipients)
    remaining = len(recipients)

    # Daily batch cap.
    if args.limit is not None:
        recipients = recipients[: args.limit]

    mode = "SEND" if args.send else "DRY RUN"
    print(f"=== Sanabreh outreach :: {mode} ===")
    print(f"From: {formataddr((FROM_NAME, FROM_EMAIL))}")
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
            msg = build_message(r)
            print(f"  [{i + 1:>2}] {msg['Subject']:<38} -> {msg['To']}")
        # show one full rendered sample so the copy can be eyeballed
        sample = build_message(recipients[0])
        print("\n----- sample (first recipient) -----")
        print(f"To:      {sample['To']}")
        print(f"Subject: {sample['Subject']}\n")
        print(sample.get_content())
        print("------------------------------------")
        print("\nDRY RUN complete. No emails were sent.")
        print("Re-run with --send to deliver.")
        return

    password = get_password()
    if not password:
        sys.exit(
            "No password found.\n"
            "Add a line to the gitignored .env file at the project root:\n"
            "    SANABREH_EMAIL_PASS=your-password-here\n"
            "or run:  export SANABREH_EMAIL_PASS='your-password-here'"
        )

    context = make_ssl_context()
    sent, failed = 0, []
    state = load_state()
    # Open the Sent mailbox up front so each copy is filed immediately after
    # its send. If the run is interrupted, everything sent so far is recorded.
    imap, folder = (None, None)
    if not args.no_save_sent:
        imap, folder = open_sent_mailbox(password)

    print("Connecting to SMTP server...")
    try:
        with smtplib.SMTP_SSL(SMTP_HOST, SMTP_PORT, context=context) as server:
            server.login(FROM_EMAIL, password)
            print("Logged in. Sending...\n")
            for i, r in enumerate(recipients):
                msg = build_message(r)
                try:
                    server.send_message(msg)
                    sent += 1
                    append_sent(r["email"])  # record immediately so reruns skip it
                    state[r["email"].lower()] = {
                        "email": r["email"].lower(),
                        "name": r.get("name", ""),
                        "handle": r.get("handle", ""),
                        "followers": r.get("followers", 0),
                        "first_sent": now_iso(),
                        "last_sent": now_iso(),
                        "touches": 1,
                        "subject": msg["Subject"],
                        "replied": False,
                        "replied_at": None,
                    }
                    save_state(state)
                    saved = append_to_sent(imap, folder, msg)  # file copy now
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
