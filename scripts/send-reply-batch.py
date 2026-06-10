#!/usr/bin/env python3
"""
One-off: send approved, personalized replies to the 5 interested leads as
THREADED replies (sets In-Reply-To/References from each lead's inbound message
so it lands in the existing conversation). Files a copy to Sent.

Dry run by default; pass --send to actually deliver.
"""
import argparse, email, imaplib, ssl, sys, time, random
from email.message import EmailMessage
from email.header import decode_header
from email.utils import formataddr
from pathlib import Path
import importlib.util

spec = importlib.util.spec_from_file_location("s", str(Path(__file__).parent / "send-outreach.py"))
m = importlib.util.module_from_spec(spec); spec.loader.exec_module(m)

FROM_EMAIL, FROM_NAME, IMAP_HOST = m.FROM_EMAIL, m.FROM_NAME, m.IMAP_HOST

DRAFTS = {
    "collabwithtiffanytv@gmail.com": """Hi Tiffany,

Love that you're in, and great questions. Here's the full picture.

Phase 1, the deliverable: one 60-second reel that showcases Sanabreh and the food, with full creative range on how you do it. We also ask that you share it to your story at least once a week through the 30-day trial. We've found the story reshares really boost engagement, which in turn lets us pay creators more down the line.

How we measure it: we look at everything, starting with engagement on the post, views, watch time, likes, shares, reposts, saves, comments, and the same on your stories. When you reshare to your story we'll give you a specific link to include for Sanabreh so we can track traffic, plus a code to mention in the video so we can track reservations. We know this is a trial, so results vary widely, and we take all of it into account. Our real goal is a long-term relationship, ideally creating together one or two times a month.

Phase 2, the paid side: we build a custom package based on what fits your audience. Deliverables are usually a 60 to 90-second reel, and we're also open to simpler collab image posts, like a selfie in the restaurant trying the food. Once we agree on deliverables I send over an influencer agreement that spells out payment and usage rights, with compensation paid in full once we receive and approve the work. I can't give an exact number up front since it's based on the Phase 1 results, but for a following your size, if the engagement checks out, it typically lands somewhere between 250 and 750 per agreement. We can do individual deals or package deals for a set number of posts and reels.

To get started, what day and time would you like to come in? Your meal is on us, plus a free drink and hookah.

Ray
Outreach Manager, Sanabreh
""",
    "contentbyjulianne@gmail.com": """Hi Jay,

Good questions, here's how it works.

Phase 1 is one short video on TikTok, around 60 seconds, showcasing Sanabreh and the food, with full creative freedom. If you can also reshare it to your story about once a week during the 30-day trial, that helps it gain traction.

For measuring performance, we look at the full engagement picture: views, watch time, likes, shares, reposts, saves, and comments, plus your stories. We can give you a specific link to share and a code to mention in the video so we can also track traffic and reservations. It's a trial, so we know results vary, and we factor all of it in.

On your Phase 2 question, yes: based on the analytics from that first video, we move into paid work and offer either a price per piece of content or a package, customized to your audience. Once we agree on deliverables I send an influencer agreement covering payment and usage rights, with payment in full after we receive and approve the content.

If you want to get rolling, what day and time work for you to come in? The meal is on us, along with a free drink and hookah.

Ray
Outreach Manager, Sanabreh
""",
    "missmadamemattel@gmail.com": """Hi Bia,

Happy to lay out the fundamentals.

To your question: we're comping one meal, yours, along with a free drink and hookah. You're welcome to bring someone, that just covers the one meal.

For Phase 1 we ask for one short video, around 60 seconds, featuring Sanabreh and the food, with full creative range on how you do it. If you can reshare it to your story about once a week during the 30-day trial, that really helps engagement. We measure the full picture, views, watch time, likes, shares, saves, comments, and can give you a link and a code to track traffic and reservations too. It's a trial, so results vary and we take all of it into account. Our goal is a long-term relationship, ideally creating together once or twice a month.

If that sounds good, what day and time would you like to come in?

Ray
Outreach Manager, Sanabreh
""",
    "eatinwitsantana@gmail.com": """Hi there,

Love it, let's get you in.

For Phase 1 all we ask is one short video, around 60 seconds, showcasing Sanabreh and the food, with full creative freedom. If you can also reshare it to your story about once a week through the 30-day trial, that helps it gain traction. We'll give you a link to share and a code to mention so we can track traffic and reservations, and we take the full engagement picture into account since this is a trial.

What day and time work best for you to come in? Your meal is on us, plus a free drink and hookah.

Ray
Outreach Manager, Sanabreh
""",
    "sydneydonatella@gmail.com": """Hi Sydney,

Totally understand, and we do pay creators. The way we structure it, the first video acts as a quick trial so we can see how your audience responds, and the paid partnership in Phase 2 is built directly off those results. We've found it lets us pay fairly based on real performance rather than follower count alone.

To gauge what makes sense on our end, would you be able to send a screenshot of your analytics from the last 30 days? Once we see your engagement and reach, we can talk numbers and put together a package that works for you.

Looking forward to it.

Ray
Outreach Manager, Sanabreh
""",
}


def dec(v):
    return "".join(t.decode(e or "utf-8", "replace") if isinstance(t, bytes) else t
                    for t, e in decode_header(v or ""))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--send", action="store_true")
    args = ap.parse_args()
    pw = m.get_password()
    if not pw:
        sys.exit("No password found.")
    ctx = m.make_ssl_context()

    # Fetch each lead's inbound Message-ID + Subject for proper threading.
    threads = {}
    with imaplib.IMAP4_SSL(IMAP_HOST, m.IMAP_PORT, ssl_context=ctx) as im:
        im.login(FROM_EMAIL, pw); im.select("INBOX")
        for e in DRAFTS:
            typ, data = im.search(None, "FROM", f'"{e}"')
            ids = data[0].split()
            if not ids:
                threads[e] = (None, "re: collaboration")
                continue
            typ, md = im.fetch(ids[-1], "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID SUBJECT)])")
            msg = email.message_from_bytes(md[0][1])
            subj = dec(msg.get("Subject")) or "re: collaboration"
            if not subj.lower().startswith("re:"):
                subj = "Re: " + subj
            threads[e] = (msg.get("Message-ID"), subj)

    print(f"=== reply batch :: {'SEND' if args.send else 'DRY RUN'} ===\n")
    if not args.send:
        for e, (mid, subj) in threads.items():
            print(f"  -> {e}\n     Subject: {subj}\n     In-Reply-To: {mid}\n")
        print("DRY RUN. Re-run with --send to deliver.")
        return

    imap, folder = m.open_sent_mailbox(pw)
    sent = 0
    with __import__("smtplib").SMTP_SSL(m.SMTP_HOST, m.SMTP_PORT, context=ctx) as server:
        server.login(FROM_EMAIL, pw)
        for i, (e, body) in enumerate(DRAFTS.items()):
            mid, subj = threads[e]
            msg = EmailMessage()
            msg["From"] = formataddr((FROM_NAME, FROM_EMAIL))
            msg["To"] = e
            msg["Subject"] = subj
            msg["Reply-To"] = FROM_EMAIL
            if mid:
                msg["In-Reply-To"] = mid
                msg["References"] = mid
            msg.set_content(body)
            try:
                server.send_message(msg)
                m.append_to_sent(imap, folder, msg)
                sent += 1
                print(f"  [{i+1}/{len(DRAFTS)}] replied -> {e}")
            except Exception as ex:
                print(f"  [{i+1}/{len(DRAFTS)}] FAILED -> {e}: {ex}")
            if i < len(DRAFTS) - 1:
                time.sleep(random.uniform(8, 20))
    if imap:
        try: imap.logout()
        except Exception: pass
    print(f"\nDone. Replies sent: {sent}.")


if __name__ == "__main__":
    main()
