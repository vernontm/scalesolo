#!/usr/bin/env python3
"""Build the vtm-rebuild recipients file: one bespoke pitch email per pilot lead.
CTA = view demo + reply. Framing = "a redesign concept" (no AI talk).
No em dashes, no contractions (VTM voice). Writes the file the sender reads:
scripts/vtm-vtm-rebuild-recipients.json
"""
import json
from pathlib import Path

BASE = "https://vtm-demos.vercel.app"
OUT = Path(__file__).parent.parent / "vtm-vtm-rebuild-recipients.json"
SIG = "Ray\nFounder, Vernon Tech & Media\nhttps://vernontm.com"

# (business, email, slug, subject, observation sentence, vibe-noun)
LEADS = [
 ("Coco Nail Spa", "coconailspa77005@gmail.com", "coco-nail-spa",
  "a redesign concept for Coco Nail Spa",
  "Your current site still carries a template from a few years back, and it is not really built for the phones most of your guests are booking from.",
  "salon"),
 ("Infinity Nail Spa", "infinitynailspa8@gmail.com", "infinity-nail-spa",
  "a redesign concept for Infinity Nail Spa",
  "Your current site feels a little unfinished, with a lot of empty space and no real first impression when someone lands on it.",
  "boutique"),
 ("Plush Nail Bar", "plushnailbartx@gmail.com", "plush-nail-bar",
  "a redesign concept for Plush Nail Bar",
  "A few sections of your current site are not loading the way they should, and the overall look feels a step behind a salon with as many locations as you have.",
  "salon"),
 ("Milano Nail Spa", "milanonailspameyerland@gmail.com", "milano-nail-spa",
  "a redesign concept for Milano Nail Spa",
  "Your current site has a lot going on at once, and the design feels a few years behind the experience you actually offer in the salon.",
  "salon"),
 ("Sofia Grace Nail Boutique", "contact@sofiagracenails.com", "sofia-grace-nails",
  "a redesign concept for Sofia Grace",
  "Your current site already has a nice feel to it, so I wanted to show what it could look like taken a step further into something more polished and modern.",
  "boutique"),
 ("Prestige Hand Car Wash", "prestigehandcarwash1@gmail.com", "prestige-hand-car-wash",
  "a redesign concept for Prestige Hand Car Wash",
  "Your current site runs on a basic builder template, and it does not quite show off the quality of the hand car care you actually provide.",
  "shop"),
 ("Totoro Mochi Donut", "totoromochidonut@gmail.com", "totoro-mochi-donut",
  "a redesign concept for Totoro Mochi Donut",
  "Your current site looks a bit dated next to how fun your shop and your treats actually are, and it does not make the menu easy to fall in love with.",
  "shop"),
 ("Kokee Tea", "hello@kokeetea.com", "kokee-tea",
  "a redesign concept for Kokee Tea",
  "Your current site feels a little thin and dated, and it does not quite capture how fresh and hand-crafted your drinks really are.",
  "shop"),
 ("Dripped Nails & Spa", "drippedhtx@gmail.com", "dripped-nails",
  "a redesign concept for Dripped Nails",
  "Your current site leans on an older layout with a lot of repeated text, and it does not quite match the calm, modern vibe of the spa itself.",
  "spa"),
 ("The Coffee Garden", "info@thecoffeegarden.com", "coffee-garden",
  "a redesign concept for The Coffee Garden",
  "Your current site works, but it does not quite capture the warmth of the shop, and there is a lot of room to turn more visitors into walk-ins.",
  "shop"),
 ("Palazzio Nail Lounge", "palazzionailloungeriveroaks@gmail.com", "palazzio-nail",
  "a redesign concept for Palazzio Nail Lounge",
  "Your current site is solid, but for a luxury lounge in River Oaks there is real room to make it feel as elevated online as it does in person.",
  "lounge"),
 ("Dorado Nail Bar", "doradonailbar@yahoo.com", "dorado-nail",
  "a redesign concept for Dorado Nail Bar",
  "Your current site does the job, but it could do a lot more to show off the glamour and style you bring to every set.",
  "salon"),
 ("Pretty Nails & Lashes", "prettynailslashes100b@gmail.com", "pretty-nails",
  "a redesign concept for Pretty Nails & Lashes",
  "Your current site covers the basics, but it could do much more to show off your work and turn visitors into bookings.",
  "salon"),
 ("Luce Avenue Coffee Roasters", "info@lucecoffeeroasters.com", "luce-coffee",
  "a redesign concept for Luce Avenue Coffee Roasters",
  "Your current site works, but for a specialty roaster there is real room to make the shop and your beans feel more premium online.",
  "shop"),
 ("Brio Hand Carwash & Detail", "briocarwash@gmail.com", "brio-carwash",
  "a redesign concept for Brio Hand Carwash",
  "Your current site gets the basics across, but it does not quite show off the quality and care you put into every wash and detail.",
  "shop"),
]


def body(business, slug, observation, vibe):
    link = f"{BASE}/{slug}/"
    # food/drink shops have a menu, not services
    uses = "menu" if slug in ("totoro-mochi-donut", "kokee-tea", "coffee-garden") else "services"
    return (
        f"Hi {business} team,\n\n"
        f"I am Ray, the founder of Vernon Tech and Media, and I build websites for small businesses here in Houston. "
        f"I came across {business} and took a look at your website.\n\n"
        f"{observation}\n\n"
        f"So I went ahead and put together a redesign concept to show what a modern version could look like. "
        f"You can see it here:\n\n"
        f"{link}\n\n"
        f"It uses your real {uses} and information, it is built mobile first, and it is designed to feel like the kind of {vibe} people want to walk into. "
        f"There is no cost and no obligation, I just thought it would land better to show you than to tell you.\n\n"
        f"If you like the direction, just reply and we can talk about making it your real website.\n\n"
        f"{SIG}\n"
    )


def main():
    recs = []
    for business, email, slug, subject, observation, vibe in LEADS:
        recs.append({
            "name": business,
            "email": email,
            "subject": subject,
            "demo_url": f"{BASE}/{slug}/",
            "custom_body": body(business, slug, observation, vibe),
        })
    OUT.write_text(json.dumps(recs, indent=2, ensure_ascii=False) + "\n")
    print(f"Wrote {len(recs)} recipients -> {OUT}\n")
    s = recs[0]
    print("===== SAMPLE (first recipient) =====")
    print("To:     ", s["name"], "<" + s["email"] + ">")
    print("Subject:", s["subject"])
    print()
    print(s["custom_body"])


if __name__ == "__main__":
    main()
