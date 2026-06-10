#!/usr/bin/env python3
"""
Send touch-2 follow-ups to contacted leads who never replied.

Re-checks the inbox at run time, so anyone who has replied since the first
touch is automatically skipped. Threads onto the original outreach so it lands
in the same conversation. Records the touch in outreach-state.json.

Usage:
    python3 scripts/send-followups.py              # dry run (lists who would get one)
    python3 scripts/send-followups.py --send       # actually send
    python3 scripts/send-followups.py --send --limit 40
"""
import argparse, email, imaplib, smtplib, sys, time, random, json
from email.header import decode_header
from email.utils import formataddr
from pathlib import Path
import importlib.util

HERE = Path(__file__).parent
spec = importlib.util.spec_from_file_location("s", str(HERE / "send-outreach.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

SENT_LOG = HERE / "outreach-sent-log.txt"
STATE = HERE / "outreach-state.json"

# Never follow up: bounced address, agency (no cold follow-up), and active
# conversations handled off the main thread.
EXCLUDE = {
    "bilal@jakerosenentertainment.com",
    "arleneslaisburyy@yahoo.com",
    "contact@livelifewithari.com",
    "negrafeminist@gmail.com",
}


def dec(v):
    return "".join(t.decode(e or "utf-8", "replace") if isinstance(t, bytes) else t
                    for t, e in decode_header(v or ""))


def load_sent():
    out = []
    for l in SENT_LOG.read_text().splitlines():
        l = l.strip().lower()
        if l and not l.startswith("#") and l not in out:
            out.append(l)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true")
    ap.add_argument("--queue", help="Path to a file of emails to follow up (one per line). Defaults to the full sent-log.")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--delay-min", type=float, default=35.0)
    ap.add_argument("--delay-max", type=float, default=75.0)
    args = ap.parse_args()

    pw = m.get_password()
    if not pw:
        sys.exit("No password found.")
    ctx = m.make_ssl_context()
    state = json.loads(STATE.read_text()) if STATE.exists() else {}

    # Source list: a frozen queue file, or the whole sent-log.
    if args.queue:
        source = [l.strip().lower() for l in Path(args.queue).read_text().splitlines()
                  if l.strip() and not l.startswith("#")]
    else:
        source = load_sent()

    # Build the no-reply list + grab threading headers from the Sent copy.
    targets = []
    with imaplib.IMAP4_SSL(m.IMAP_HOST, m.IMAP_PORT, ssl_context=ctx) as im:
        im.login(m.FROM_EMAIL, pw)
        for e in source:
            if e in EXCLUDE:
                continue
            # already at max touches?
            if state.get(e, {}).get("touches", 1) >= m.MAX_TOUCHES:
                continue
            im.select("INBOX")
            typ, d = im.search(None, "FROM", f'"{e}"')
            if d[0].split():
                continue  # they replied -> skip
            im.select("INBOX.Sent")
            typ, d = im.search(None, "TO", f'"{e}"')
            ids = d[0].split()
            mid, subj = None, "re: collaboration"
            if ids:
                typ, md = im.fetch(ids[-1], "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT)])")
                h = email.message_from_bytes(md[0][1])
                mid = h.get("Message-ID")
                s = dec(h.get("Subject"))
                if s:
                    subj = s if s.lower().startswith("re:") else "Re: " + s
            name = state.get(e, {}).get("name") or "there"
            targets.append({"email": e, "name": name, "subject": subj, "mid": mid})

    if args.limit is not None:
        targets = targets[: args.limit]

    print(f"=== follow-ups (touch 2) :: {'SEND' if args.send else 'DRY RUN'} ===")
    print(f"No-reply leads to follow up: {len(targets)}\n")
    if not targets:
        print("Nobody to follow up. All caught up.")
        return
    if not args.send:
        for t in targets:
            print(f"  -> {t['name']:14} {t['email']}")
        print("\nDRY RUN. Re-run with --send to deliver.")
        return

    imap, folder = m.open_sent_mailbox(pw)
    sent_n = 0
    with smtplib.SMTP_SSL(m.SMTP_HOST, m.SMTP_PORT, context=ctx) as server:
        server.login(m.FROM_EMAIL, pw)
        for i, t in enumerate(targets):
            r = {"name": t["name"], "email": t["email"], "personal_line": "yours stood out"}
            msg = m.build_followup_message(r, 2, t["subject"])
            if t["mid"]:
                msg["In-Reply-To"] = t["mid"]; msg["References"] = t["mid"]
            try:
                server.send_message(msg)
                m.append_to_sent(imap, folder, msg)
                st = state.get(t["email"], {"email": t["email"], "name": t["name"]})
                st["touches"] = 2; st["last_sent"] = m.now_iso()
                state[t["email"]] = st
                m.save_state(state)
                sent_n += 1
                print(f"  [{i+1}/{len(targets)}] follow-up -> {t['email']}")
            except Exception as ex:
                print(f"  [{i+1}/{len(targets)}] FAILED -> {t['email']}: {ex}")
            if i < len(targets) - 1:
                time.sleep(random.uniform(args.delay_min, args.delay_max))
    if imap:
        try: imap.logout()
        except Exception: pass
    print(f"\nDone. Follow-ups sent: {sent_n}.")


if __name__ == "__main__":
    main()
