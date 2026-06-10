#!/usr/bin/env python3
"""
Generate all VTM redesign demo sites from one shared template (the approved
Coco design), each driven by per-lead config. Self-hosts every image.

Output: scripts/leadgen/vtm-demos/<slug>/index.html (+ assets/)
Deploy the whole vtm-demos/ folder once:  vercel deploy --prod --yes
Each lead then lives at  vtm-demos.vercel.app/<slug>/
"""
import urllib.request, ssl, certifi
from pathlib import Path

CTX = ssl.create_default_context(cafile=certifi.where())
UA = ('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 '
      '(KHTML, like Gecko) Chrome/124.0 Safari/537.36')
ROOT = Path(__file__).parent / "vtm-demos"

# verified Unsplash photo-id sets per category (all confirmed 200 + valid jpeg)
NAIL = dict(hero="photo-1604654894610-df63bc536371", about="photo-1519014816548-bf5fe059798b",
            band="photo-1610992015732-2449b76344bc", g1="photo-1632345031435-8727f6897d53",
            g2="photo-1604902396830-aca29e19b067", g3="photo-1607779097040-26e80aa78e66",
            g4="photo-1519014816548-bf5fe059798b")
CARWASH = dict(hero="photo-1520340356584-f9917d1eea6f", about="photo-1552519507-da3b142c6e3d",
               band="photo-1607860108855-64acf2078ed9", g1="photo-1605559424843-9e4c228bf1c2",
               g2="photo-1542362567-b07e54358753", g3="photo-1597007066704-67bf2068d5b2",
               g4="photo-1583121274602-3e2820c69888")
DONUT = dict(hero="photo-1551024601-bec78aea704b", about="photo-1527515637462-cff94eecc1ac",
             band="photo-1438480478735-3234e63615bb", g1="photo-1514517604298-cf80e0fb7f1e",
             g2="photo-1483695028939-5bb13f8648b0", g3="photo-1558326567-98ae2405596b",
             g4="photo-1505250469679-203ad9ced0cb")
TEA = dict(hero="photo-1558857563-b371033873b8", about="photo-1546173159-315724a31696",
           band="photo-1497534547324-0ebb3f052e88", g1="photo-1571091718767-18b5b1457add",
           g2="photo-1558160074-4d7d8bdf4256", g3="photo-1546173159-315724a31696",
           g4="photo-1571091718767-18b5b1457add")

W = dict(hero=1700, about=900, band=1600, g1=600, g2=600, g3=600, g4=600)


def download_assets(slug, idset):
    d = ROOT / slug / "assets"; d.mkdir(parents=True, exist_ok=True)
    for name, pid in idset.items():
        out = d / f"{name}.jpg"
        if out.exists() and out.stat().st_size > 12000:
            continue
        url = f"https://images.unsplash.com/{pid}?auto=format&fit=crop&w={W[name]}&q=80"
        req = urllib.request.Request(url, headers={"User-Agent": UA})
        out.write_bytes(urllib.request.urlopen(req, timeout=40, context=CTX).read())


def svc_cards(services):
    out = []
    for i, (t, desc, price) in enumerate(services, 1):
        out.append(
            f'      <div class="svc"><div class="no">{i:02d}</div>'
            f'<h3>{t}</h3><p>{desc}</p><div class="price">{price}</div></div>')
    return "\n".join(out)


def strip_items(items):
    return "\n".join(f'    <div><span>&#9733;</span> {x}</div>' for x in items)


TEMPLATE = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{brand} · {tagline}</title>
<meta name="description" content="{meta_desc}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@400;500;600;700&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<style>
  :root{{--ink:{ink};--cream:{cream};--gold:{gold};--gold-soft:{goldsoft};--muted:{muted};--line:rgba(0,0,0,.12)}}
  *{{margin:0;padding:0;box-sizing:border-box}}
  html{{scroll-behavior:smooth}}
  body{{font-family:'Inter',sans-serif;color:var(--ink);background:var(--cream);line-height:1.6;-webkit-font-smoothing:antialiased}}
  h1,h2,h3{{font-family:'Cormorant Garamond',serif;font-weight:600;line-height:1.1}}
  .wrap{{max-width:1180px;margin:0 auto;padding:0 28px}}
  a{{color:inherit;text-decoration:none}}
  .btn{{display:inline-block;padding:15px 34px;border-radius:999px;font-size:.82rem;letter-spacing:.14em;text-transform:uppercase;font-weight:500;transition:.25s}}
  .btn-gold{{background:var(--gold);color:#fff}}
  .btn-gold:hover{{filter:brightness(.92);transform:translateY(-2px)}}
  .btn-ghost{{border:1px solid rgba(255,255,255,.6);color:#fff}}
  .btn-ghost:hover{{background:rgba(255,255,255,.12)}}
  .eyebrow{{font-size:.74rem;letter-spacing:.32em;text-transform:uppercase;color:var(--gold);font-weight:600}}
  header{{position:fixed;top:0;width:100%;z-index:50;transition:.3s;padding:22px 0}}
  header.scrolled{{background:color-mix(in srgb,var(--cream) 92%,transparent);backdrop-filter:blur(10px);padding:14px 0;box-shadow:0 1px 0 var(--line)}}
  .nav{{display:flex;align-items:center;justify-content:space-between}}
  .logo{{font-family:'Cormorant Garamond',serif;font-size:1.7rem;font-weight:700;letter-spacing:.04em;color:#fff;transition:.3s}}
  header.scrolled .logo{{color:var(--ink)}}
  .logo span{{color:var(--gold)}}
  .links{{display:flex;gap:34px;align-items:center}}
  .links a{{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.92)}}
  header.scrolled .links a{{color:var(--ink)}}
  .links a:hover{{color:var(--gold-soft)}}
  .nav .btn{{padding:11px 24px}}
  @media(max-width:860px){{.links a:not(.btn){{display:none}}}}
  .hero{{position:relative;min-height:100vh;display:flex;align-items:center;background:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.45)),url('./assets/hero.jpg') center/cover}}
  .hero-inner{{max-width:720px;color:#fff}}
  .hero .eyebrow{{color:var(--gold-soft)}}
  .hero h1{{font-size:clamp(3rem,7vw,5.6rem);margin:18px 0 10px}}
  .hero h1 em{{font-style:italic;color:var(--gold-soft)}}
  .hero p{{font-size:1.12rem;font-weight:300;max-width:520px;margin-bottom:34px;color:rgba(255,255,255,.9)}}
  .hero .cta-row{{display:flex;gap:16px;flex-wrap:wrap}}
  .strip{{background:var(--ink);color:var(--cream);text-align:center;padding:26px 0}}
  .strip .wrap{{display:flex;justify-content:center;gap:60px;flex-wrap:wrap;font-size:.82rem;letter-spacing:.18em;text-transform:uppercase}}
  .strip span{{color:var(--gold-soft)}}
  section{{padding:108px 0}}
  .sec-head{{text-align:center;max-width:640px;margin:0 auto 64px}}
  .sec-head h2{{font-size:clamp(2.4rem,4.5vw,3.4rem);margin:14px 0}}
  .sec-head p{{color:var(--muted)}}
  .about{{display:grid;grid-template-columns:1fr 1fr;gap:72px;align-items:center}}
  .about-img{{aspect-ratio:4/5;border-radius:8px;background:linear-gradient(135deg,rgba(0,0,0,.1),rgba(0,0,0,.3)),url('./assets/about.jpg') center/cover;box-shadow:0 30px 60px -30px rgba(0,0,0,.5)}}
  .about h2{{font-size:clamp(2.2rem,4vw,3rem);margin-bottom:8px}}
  .about .eyebrow{{display:block;margin-bottom:6px}}
  .about p{{color:var(--muted);margin:18px 0}}
  .about .sig{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--gold)}}
  @media(max-width:820px){{.about{{grid-template-columns:1fr;gap:36px}}.about-img{{aspect-ratio:16/10}}}}
  .services{{background:#fff}}
  .svc-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}}
  .svc{{border:1px solid var(--line);border-radius:10px;padding:38px 30px;transition:.3s;background:var(--cream)}}
  .svc:hover{{transform:translateY(-6px);box-shadow:0 24px 48px -28px rgba(0,0,0,.4);border-color:transparent}}
  .svc .no{{font-family:'Cormorant Garamond',serif;font-size:1.1rem;color:var(--gold);letter-spacing:.1em}}
  .svc h3{{font-size:1.7rem;margin:8px 0 10px}}
  .svc p{{font-size:.92rem;color:var(--muted)}}
  .svc .price{{margin-top:18px;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;font-weight:600}}
  @media(max-width:820px){{.svc-grid{{grid-template-columns:1fr 1fr}}}}
  @media(max-width:560px){{.svc-grid{{grid-template-columns:1fr}}}}
  .gallery{{padding-top:0}}
  .g-grid{{display:grid;grid-template-columns:repeat(4,1fr);gap:14px}}
  .g-grid div{{aspect-ratio:1;border-radius:8px;background-size:cover;background-position:center}}
  @media(max-width:680px){{.g-grid{{grid-template-columns:1fr 1fr}}}}
  .band{{background:linear-gradient(rgba(0,0,0,.78),rgba(0,0,0,.78)),url('./assets/band.jpg') center/cover;color:#fff;text-align:center}}
  .band h2{{font-size:clamp(2.4rem,5vw,3.6rem)}}
  .band p{{color:rgba(255,255,255,.85);max-width:520px;margin:14px auto 30px;font-weight:300}}
  footer{{background:var(--ink);color:rgba(255,255,255,.85);padding:80px 0 36px}}
  .foot-grid{{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:50px;padding-bottom:50px;border-bottom:1px solid rgba(255,255,255,.1)}}
  footer .logo{{color:#fff;font-size:2rem}}
  footer h4{{font-family:'Inter';font-size:.78rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-soft);margin-bottom:16px;font-weight:600}}
  footer p,footer a{{font-size:.95rem;font-weight:300;color:rgba(255,255,255,.8);display:block;margin-bottom:8px}}
  footer a:hover{{color:#fff}}
  .copy{{text-align:center;padding-top:28px;font-size:.78rem;color:rgba(255,255,255,.45)}}
  @media(max-width:760px){{.foot-grid{{grid-template-columns:1fr;gap:32px}}.strip .wrap{{gap:24px}}}}
  .concept{{position:fixed;bottom:18px;left:18px;z-index:80;background:var(--ink);color:#fff;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;padding:10px 16px;border-radius:999px;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15)}}
  .concept b{{color:var(--gold-soft);font-weight:600}}
</style>
</head>
<body>
<header id="hdr">
  <div class="wrap nav">
    <div class="logo">{logo}<span>.</span></div>
    <nav class="links">
      <a href="#about">About</a>
      <a href="#services">{svc_label}</a>
      <a href="#gallery">Gallery</a>
      <a href="#visit">Visit</a>
      <a href="{cta_href}" class="btn btn-gold">{cta}</a>
    </nav>
  </div>
</header>
<section class="hero">
  <div class="wrap hero-inner">
    <span class="eyebrow">{location_eyebrow}</span>
    <h1>{hero_title}</h1>
    <p>{hero_sub}</p>
    <div class="cta-row">
      <a href="{cta_href}" class="btn btn-gold">{cta}</a>
      <a href="#services" class="btn btn-ghost">{svc_label}</a>
    </div>
  </div>
</section>
<div class="strip"><div class="wrap">
{strip}
</div></div>
<section id="about"><div class="wrap about">
  <div class="about-img"></div>
  <div>
    <span class="eyebrow">{about_eyebrow}</span>
    <h2>{about_h2}</h2>
    <p>{about_p1}</p>
    <p>{about_p2}</p>
    <div class="sig">— The {brand} Team</div>
  </div>
</div></section>
<section id="services" class="services"><div class="wrap">
  <div class="sec-head"><span class="eyebrow">{svc_eyebrow}</span><h2>{svc_head}</h2><p>{svc_sub}</p></div>
  <div class="svc-grid">
{svc_cards}
  </div>
</div></section>
<section id="gallery" class="gallery"><div class="wrap">
  <div class="sec-head"><span class="eyebrow">{gal_eyebrow}</span><h2>{gal_head}</h2></div>
  <div class="g-grid">
    <div style="background-image:url('./assets/g1.jpg')"></div>
    <div style="background-image:url('./assets/g2.jpg')"></div>
    <div style="background-image:url('./assets/g3.jpg')"></div>
    <div style="background-image:url('./assets/g4.jpg')"></div>
  </div>
</div></section>
<section class="band"><div class="wrap">
  <span class="eyebrow" style="color:var(--gold-soft)">{band_eyebrow}</span>
  <h2>{band_head}</h2><p>{band_sub}</p>
  <a href="{cta_href}" class="btn btn-gold">{cta}</a>
</div></section>
<footer id="visit"><div class="wrap">
  <div class="foot-grid">
    <div><div class="logo">{logo}<span style="color:var(--gold)">.</span></div>
      <p style="margin-top:14px;max-width:300px">{foot_blurb}</p></div>
    <div><h4>Visit Us</h4><p>{address}</p>{phone_line}</div>
    <div><h4>Hours</h4>{hours}<a href="{cta_href}" class="btn btn-gold" style="margin-top:12px">{cta}</a></div>
  </div>
  <div class="copy">© 2026 {brand}. All rights reserved.</div>
</div></footer>
<div class="concept">Redesign concept by <b>Vernon Tech &amp; Media</b></div>
<script>
  const h=document.getElementById('hdr');
  const f=()=>h.classList.toggle('scrolled',window.scrollY>60);f();
  window.addEventListener('scroll',f,{{passive:true}});
</script>
</body>
</html>
"""


def build(cfg):
    slug = cfg["slug"]
    download_assets(slug, cfg["assets"])
    html = TEMPLATE.format(
        strip=strip_items(cfg["strip"]),
        svc_cards=svc_cards(cfg["services"]),
        **{k: v for k, v in cfg.items() if k not in ("assets", "strip", "services")},
    )
    (ROOT / slug / "index.html").write_text(html)
    print(f"  built {slug}  ({len(cfg['services'])} services)")


# --------------------------------------------------------------------------
NAIL_HOURS = "<p>Mon – Sat · 9:30am – 7:30pm</p><p>Sunday · 11:00am – 6:00pm</p>"

CONFIGS = [
  dict(slug="coco-nail-spa", brand="Coco Nail Spa", logo="Coco", assets=NAIL,
       ink="#1a1614", cream="#f6efe7", gold="#c79a54", goldsoft="#e3c892", muted="#7a716a",
       tagline="Luxury Nail Salon in Houston, TX",
       meta_desc="Coco Nail Spa on Buffalo Speedway, Houston. Luxurious manicures, pedicures and nail care.",
       location_eyebrow="Buffalo Speedway · Houston, TX",
       hero_title="Your nails, a <em>reflection</em> of you",
       hero_sub="A luxury nail and spa experience built on clean, modern care. Pamper, rejuvenate, and restore in a space designed for you.",
       cta="Book Now", cta_href="tel:7132390601", svc_label="Services",
       strip=["Paperless, sterilized tools","Full nail, skin &amp; spa care","Open 7 days a week"],
       about_eyebrow="About Our Salon", about_h2="A one stop shop for nail beauty",
       about_p1="Welcome to Coco Nail Spa on Buffalo Speedway in Houston, where your comfort and safety are our priority. Indulge in luxurious treatments from a full line of nail, skin, and spa care.",
       about_p2="As our guest you are entitled to the finest products and services available. Our innovative paperless chairs and instruments are sterilized after every use.",
       svc_eyebrow="What We Offer", svc_head="Signature Services", svc_sub="A full menu of nail, skin, and spa care, delivered with detail.",
       services=[("Manicure","Classic to luxury manicures that leave hands soft and polished.","From $20"),
                 ("Pedicure","Spa pedicures with soak, exfoliation, and massage.","From $35"),
                 ("Nail Enhancement","Acrylic, gel, and dip extensions shaped to your style.","From $45"),
                 ("À La Carte","Add-ons and finishing touches to customize any service.","Varies"),
                 ("Princess Mani &amp; Pedi","A gentle, fun experience for our youngest guests.","From $25"),
                 ("Waxing","Smooth, precise waxing in a clean, comfortable setting.","From $12")],
       gal_eyebrow="Our Work", gal_head="The Gallery",
       band_eyebrow="Ready when you are", band_head="Treat yourself today",
       band_sub="Walk-ins welcome, appointments preferred. Call us and we will take care of the rest.",
       foot_blurb="A luxury nail and spa experience on Buffalo Speedway, Houston.",
       address="Buffalo Speedway<br>Houston, TX 77005", phone_line='<a href="tel:7132390601">(713) 239-0601</a>',
       hours=NAIL_HOURS),

  dict(slug="infinity-nail-spa", brand="Infinity Nail Spa", logo="Infinity", assets=NAIL,
       ink="#0f211d", cream="#eef3f0", gold="#bf9d54", goldsoft="#ddc488", muted="#5f6d68",
       tagline="Endless Kingdom of Beauty · Houston, TX",
       meta_desc="Infinity Nail Spa, a cozy beauty boutique in Houston 77027 offering high-class nail and spa services.",
       location_eyebrow="Houston, TX 77027",
       hero_title="An endless kingdom of <em>beauty</em>",
       hero_sub="A cozy beauty boutique offering high-class nail and spa services, made to embellish and nourish your beauty from the inside out.",
       cta="Book Now", cta_href="tel:7134922547", svc_label="Services",
       strip=["High-class nail care","Clean &amp; cozy boutique","Walk-ins welcome"],
       about_eyebrow="About Us", about_h2="Beauty, nourished from within",
       about_p1="Infinity Nail Spa is a cozy beauty boutique in Houston 77027 offering high-class nail and spa services, aiming to embellish and nourish your beauty from the inside out.",
       about_p2="From acrylic, dip powder, and gel to relaxing spa treatments, our team delivers a clean, welcoming experience every visit.",
       svc_eyebrow="What We Offer", svc_head="Our Services", svc_sub="Full-range nail beauty and spa care.",
       services=[("Manicure","Classic and luxury manicures finished to perfection.","From $20"),
                 ("Pedicure","Relaxing spa pedicures from soak to massage.","From $35"),
                 ("Acrylic &amp; Extensions","Full-set acrylic and extensions in any shape.","From $45"),
                 ("Dip Powder","Long-lasting, lightweight dip powder color.","From $40"),
                 ("Gel Polish","Glossy, chip-resistant gel that lasts for weeks.","From $30"),
                 ("Waxing","Gentle, precise waxing services.","From $12")],
       gal_eyebrow="Our Work", gal_head="The Gallery",
       band_eyebrow="Ready when you are", band_head="Come find your shine",
       band_sub="A great experience every visit, just like our regulars say. Book your appointment today.",
       foot_blurb="A cozy beauty boutique in Houston, the endless kingdom of beauty.",
       address="Houston, TX 77027", phone_line='<a href="tel:7134922547">(713) 492-2547</a>',
       hours=NAIL_HOURS),

  dict(slug="plush-nail-bar", brand="Plush Nail Bar", logo="Plush", assets=NAIL,
       ink="#14130f", cream="#f5f1e8", gold="#d4af37", goldsoft="#ecd58a", muted="#736d63",
       tagline="A Full-Service Nail Salon",
       meta_desc="Plush Nail Bar, a full-service nail salon serving Kingwood, The Woodlands and beyond since 2017.",
       location_eyebrow="Kingwood · The Woodlands · Bellaire",
       hero_title="Get your <em>shine</em> on",
       hero_sub="A full-service nail salon here just for you. Since 2017 we have been making our customers look stunning and feel their best.",
       cta="Book Online", cta_href="https://plushnailbarus.com/", svc_label="Treatments",
       strip=["Full-service nail bar","Multiple Houston locations","Quality &amp; professionalism"],
       about_eyebrow="Welcome to Plush", about_h2="Look stunning, feel your best",
       about_p1="Since April 2017, Plush Nail Bar has grown to be one of the most prominent spots in the Houston area, guaranteeing quality and professionalism to every customer.",
       about_p2="Over the years we have stayed committed to making our devoted customers look stunning and feel their best. See what our team of qualified professionals can do for you.",
       svc_eyebrow="What We Offer", svc_head="Our Treatments", svc_sub="A complete menu of nail care across all our locations.",
       services=[("Manicure","Classic and gel manicures for a flawless finish.","From $22"),
                 ("Pedicure","Indulgent spa pedicures that melt the day away.","From $38"),
                 ("Nail Enhancements","Acrylic, gel, and dip full sets and fills.","From $45"),
                 ("Gel &amp; Dip","Durable, long-wearing color that keeps its shine.","From $35"),
                 ("Gift Cards","The perfect gift for someone who deserves it.","Any amount"),
                 ("Waxing","Clean, comfortable waxing services.","From $12")],
       gal_eyebrow="Our Work", gal_head="The Gallery",
       band_eyebrow="Ready when you are", band_head="Book your visit",
       band_sub="Locations across The Woodlands, Kingwood, Bellaire and more. Reserve your spot online.",
       foot_blurb="A full-service nail salon serving the Houston area since 2017.",
       address="Kingwood &amp; multiple<br>Houston-area locations",
       phone_line='<a href="https://plushnailbarus.com/">View locations</a>', hours=NAIL_HOURS),

  dict(slug="milano-nail-spa", brand="Milano Nail Spa", logo="Milano", assets=NAIL,
       ink="#21121a", cream="#f6ece9", gold="#c98b6b", goldsoft="#e3b59b", muted="#7a6a70",
       tagline="Best Nail Salon in Meyerland, Houston",
       meta_desc="Milano Nail Spa Meyerland, the best service nail salon in Houston. Walk-ins and appointments welcome.",
       location_eyebrow="Meyerland Plaza · Houston, TX",
       hero_title="Relax, refresh, <em>renew</em>",
       hero_sub="It is our pleasure to provide a comfortable and friendly place where you can truly relax and be pampered.",
       cta="Book Now", cta_href="tel:2819742904", svc_label="Services",
       strip=["Walk-ins &amp; appointments","Online booking available","Complimentary drink"],
       about_eyebrow="Our Goals", about_h2="A place to truly relax",
       about_p1="At Milano Nail Spa Meyerland it is our pleasure to provide you with a comfortable and friendly place where you can truly relax and be pampered.",
       about_p2="We are committed to delivering services that keep you looking and feeling your best, with the latest trends and the highest standards of sanitation.",
       svc_eyebrow="What We Offer", svc_head="Our Services", svc_sub="A complete menu of nail, waxing, and beauty services.",
       services=[("Pedicure","Spa pedicures designed to relax and restore.","From $35"),
                 ("Manicure","Classic, shellac, and luxury manicures.","From $20"),
                 ("Nail Enhancements","Acrylic and dipping powder full sets.","From $45"),
                 ("Shellac Manicure","Glossy, long-lasting shellac color.","From $30"),
                 ("Eyelash Extensions","Full, natural-looking lash extensions.","From $80"),
                 ("Waxing &amp; Facial","Waxing services and refreshing facial treatments.","From $15")],
       gal_eyebrow="Our Work", gal_head="The Gallery",
       band_eyebrow="Happy deals &amp; great promotions", band_head="Come get pampered",
       band_sub="Walk-ins and appointments are always welcome. Online booking is available too.",
       foot_blurb="The best service nail salon in Meyerland, Houston.",
       address="Meyerland Plaza Mall<br>Houston, TX 77096", phone_line='<a href="tel:2819742904">(281) 974-2904</a>',
       hours=NAIL_HOURS),

  dict(slug="sofia-grace-nails", brand="Sofia Grace Nail Boutique", logo="Sofia Grace", assets=NAIL,
       ink="#161413", cream="#f4eeea", gold="#c2998c", goldsoft="#ddbcb1", muted="#776e69",
       tagline="Your Definition of Beauty · Houston",
       meta_desc="Sofia Grace Nail Boutique, a tranquil Houston nail salon where elegance and satisfaction come first.",
       location_eyebrow="Houston, TX",
       hero_title="Your style, your <em>definition</em> of beauty",
       hero_sub="A tranquil, relaxing, and pleasing environment that is all about you. Customer service is our mission.",
       cta="Book Now", cta_href="tel:7139612686", svc_label="Services",
       strip=["Tranquil boutique setting","Medically sterilized tools","Latest fashion trends"],
       about_eyebrow="About Us", about_h2="Elegance and satisfaction, first",
       about_p1="Welcome to Sofia Grace Nail Boutique, where your elegance and satisfaction are our main priority. Our salon is a tranquil, relaxing, and pleasing environment that is all about you.",
       about_p2="Our motivated team are highly qualified experts who keep up with the latest trends. Safety and sanitation are key, so our instruments are medically sterilized and disinfected.",
       svc_eyebrow="What We Offer", svc_head="Signature Services", svc_sub="Refined nail care in a tranquil setting.",
       services=[("Manicure","Elegant manicures finished with precision.","From $22"),
                 ("Pedicure","Restorative spa pedicures, start to finish.","From $38"),
                 ("Nail Enhancement","Acrylic, gel, and extensions tailored to you.","From $48"),
                 ("Kids","A gentle, fun experience for little ones.","From $18"),
                 ("Waxing","Smooth, careful waxing services.","From $12"),
                 ("Add-Ons","Finishing touches to elevate any service.","Varies")],
       gal_eyebrow="Our Work", gal_head="The Gallery",
       band_eyebrow="Ready when you are", band_head="Define your beauty",
       band_sub="Be pampered by professional technicians in a setting built around you. Book today.",
       foot_blurb="A tranquil Houston nail boutique built around your elegance and satisfaction.",
       address="Houston, TX", phone_line='<a href="tel:7139612686">(713) 961-2686</a>',
       hours=NAIL_HOURS),

  dict(slug="prestige-hand-car-wash", brand="Prestige Hand Car Wash", logo="Prestige", assets=CARWASH,
       ink="#0e1726", cream="#eef3f8", gold="#2f8fd6", goldsoft="#7fc2ef", muted="#5a6675",
       tagline="The Ultimate in Car Care · Houston",
       meta_desc="Prestige Hand Car Wash in Houston. Experienced professionals delivering the ultimate in hand car care and detailing.",
       location_eyebrow="Houston, TX",
       hero_title="Experience the ultimate in <em>car care</em>",
       hero_sub="Let us take care of your car. Our experienced team is dedicated to the best possible hand wash and detailing service in Houston.",
       cta="Call Now", cta_href="tel:8329401448", svc_label="Services",
       strip=["Hand wash specialists","Experienced team","Detailing &amp; protection"],
       about_eyebrow="About Us", about_h2="A team that treats your car right",
       about_p1="At Prestige Hand Car Wash we have a team of experienced and knowledgeable professionals dedicated to providing the best possible service.",
       about_p2="From a careful hand wash to full detailing, we treat every vehicle as if it were our own, so you drive away looking your best.",
       svc_eyebrow="What We Do", svc_head="Our Services", svc_sub="Hand car care and detailing, done right.",
       services=[("Hand Car Wash","A careful, scratch-free hand wash inside and out.","From $25"),
                 ("Full Detailing","Deep interior and exterior detailing, restored shine.","From $120"),
                 ("Interior Clean","Vacuum, shampoo, and condition for a fresh cabin.","From $60"),
                 ("Wax &amp; Polish","Hand wax and polish for a deep, lasting gloss.","From $45"),
                 ("Headlight Restoration","Clear, restored headlights for safer driving.","From $40"),
                 ("Ceramic Coating","Long-term paint protection and brilliant shine.","Quote")],
       gal_eyebrow="Our Work", gal_head="The Results",
       band_eyebrow="We take care of your car", band_head="Book your wash today",
       band_sub="Experience the difference a true hand wash makes. Call us and let us take care of the rest.",
       foot_blurb="Houston hand car wash and detailing, delivering the ultimate in car care.",
       address="Houston, TX", phone_line='<a href="tel:8329401448">(832) 940-1448</a>',
       hours="<p>Mon – Sat · 8:00am – 6:00pm</p><p>Sunday · 9:00am – 4:00pm</p>"),

  dict(slug="totoro-mochi-donut", brand="Totoro Mochi Donut", logo="Totoro", assets=DONUT,
       ink="#2a1a16", cream="#fbf2ec", gold="#e2607c", goldsoft="#f2a7b9", muted="#7e6a62",
       tagline="Mochi Donuts · Corn Dogs · Fruit Tea",
       meta_desc="Totoro Mochi Donut, a charming dessert shop with mochi donuts, Korean corn dogs, and fruit tea across Houston.",
       location_eyebrow="Friendswood · Humble · Houston",
       hero_title="A delicious <em>twist</em> on a classic",
       hero_sub="Charming mochi donuts that combine the chewy texture of mochi with the sweetness of a classic donut, plus corn dogs and fruit tea.",
       cta="Order Now", cta_href="https://www.totoromochidonut.com/", svc_label="Menu",
       strip=["Fresh daily mochi donuts","Korean corn dogs","Hand-shaken fruit tea"],
       about_eyebrow="About Us", about_h2="An outstanding dessert shop",
       about_p1="Totoro Mochi Donut is a charming dessert shop specializing in mochi donuts, combining the traditional chewy texture of mochi with the beloved sweetness of donuts.",
       about_p2="Beyond our signature mochi donuts, we serve Korean corn dogs and refreshing fruit tea, so there is something to delight every craving.",
       svc_eyebrow="On The Menu", svc_head="What We Serve", svc_sub="Made fresh, served with a smile across three locations.",
       services=[("Mochi Donuts","Chewy, colorful mochi donuts in rotating flavors.","From $2.50"),
                 ("Korean Corn Dogs","Crispy, savory corn dogs done the Korean way.","From $4"),
                 ("Fruit Tea","Refreshing hand-shaken fruit teas.","From $5"),
                 ("Specialty Drinks","Seasonal and signature drink creations.","From $5.50"),
                 ("Combo Boxes","Mix and match boxes, perfect for sharing.","From $12"),
                 ("Catering","Treat your event to a spread of our favorites.","Quote")],
       gal_eyebrow="Fresh Daily", gal_head="The Gallery",
       band_eyebrow="Three Houston locations", band_head="Come treat yourself",
       band_sub="Friendswood, Humble, and Tomball Parkway. Order online or stop by for something sweet.",
       foot_blurb="A charming dessert shop serving mochi donuts, corn dogs, and fruit tea.",
       address="19070 Gulf Fwy, Friendswood<br>+ Humble &amp; Houston locations",
       phone_line='<a href="tel:8329155180">(832) 915-5180</a>',
       hours="<p>Mon – Thu · 11:00am – 9:00pm</p><p>Fri – Sun · 11:00am – 10:00pm</p>"),

  dict(slug="kokee-tea", brand="Kokee Tea", logo="Kokee", assets=TEA,
       ink="#0f2e2a", cream="#eef6f3", gold="#f0883e", goldsoft="#f7b787", muted="#5d6f6a",
       tagline="Finest, Freshest Flavored Bubble Tea",
       meta_desc="Kokee Tea: the finest teas, all-natural cane sugar, and freshest flavors. Hand-crafted bubble tea and desserts.",
       location_eyebrow="Hand-Crafted Bubble Tea",
       hero_title="It all adds up to <em>Kokee Tea</em>",
       hero_sub="The finest teas, all-natural cane sugar, and the freshest flavors. Precise recipes and hand-crafted drinks, every time.",
       cta="Order Now", cta_href="https://www.kokeetea.com/", svc_label="Menu",
       strip=["All-natural cane sugar","Precise recipes","Hand-crafted drinks"],
       about_eyebrow="About Us", about_h2="Natural ingredients, precise recipes",
       about_p1="At Kokee Tea it all starts with the finest teas, all-natural golden cane sugar, and the freshest flavors. It all adds up to something better.",
       about_p2="Every drink is hand-crafted to a precise recipe, so your favorite tastes exactly right from the first sip to the last.",
       svc_eyebrow="On The Menu", svc_head="What We Pour", svc_sub="Hand-crafted teas and desserts made to order.",
       services=[("Milk Teas","Classic and signature milk teas with chewy pearls.","From $5"),
                 ("Fruit Teas","Bright, refreshing fruit teas bursting with flavor.","From $5"),
                 ("Specialty Drinks","Seasonal creations you will not find anywhere else.","From $6"),
                 ("Toppings","Boba, jellies, popping pearls, and more.","From $0.75"),
                 ("Catering","Bring Kokee Tea to your next event.","Quote"),
                 ("Fundraising","Partner with us to raise funds the fun way.","Inquire")],
       gal_eyebrow="Hand-Crafted", gal_head="The Gallery",
       band_eyebrow="Freshest flavors", band_head="Come find your favorite",
       band_sub="Hand-crafted bubble tea made with all-natural cane sugar. Order online or visit us today.",
       foot_blurb="The finest teas, all-natural cane sugar, and the freshest flavors.",
       address="Houston, TX", phone_line='<a href="https://www.kokeetea.com/">Order online</a>',
       hours="<p>Sun – Thu · 11:00am – 9:00pm</p><p>Fri – Sat · 11:00am – 10:00pm</p>"),
]


def main():
    ROOT.mkdir(exist_ok=True)
    print(f"Building {len(CONFIGS)} sites into {ROOT} ...")
    for cfg in CONFIGS:
        build(cfg)
    print("Done.")


if __name__ == "__main__":
    main()
