#!/usr/bin/env python3
"""
Generate v2 SALON-layout demos (nail salons) from the approved Coco v2 design.
Features: real logo OR text wordmark, image service cards, 20%-off popup,
hero ken-burns + particles, auto-scroll gallery, testimonials, scroll-reveal
(+ no-JS fallback + ?shot capture mode), header hysteresis (no flicker).

Reuses each salon's EXISTING assets in vtm-demos/<slug>/assets/
(hero/about/band/g1-g4[/logo]). Service cards reference those filenames.
"""
from pathlib import Path
ROOT = Path(__file__).parent / "vtm-demos"

TPL = """<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>{brand} · {tagline}</title>
<meta name="description" content="{meta}" />
<link rel="preconnect" href="https://fonts.googleapis.com" />
<link rel="preconnect" href="https://fonts.gstatic.com" crossorigin />
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,400;0,500;0,600;0,700;1,500;1,600&family=Inter:wght@300;400;500;600&display=swap" rel="stylesheet" />
<style>
  :root{{--ink:{ink};--cream:{cream};--gold:{gold};--gold-soft:{goldsoft};--muted:{muted};--line:rgba(0,0,0,.12)}}
  *{{margin:0;padding:0;box-sizing:border-box}}
  html{{scroll-behavior:smooth}}
  body{{font-family:'Inter',sans-serif;color:var(--ink);background:var(--cream);line-height:1.6;-webkit-font-smoothing:antialiased;overflow-x:hidden}}
  h1,h2,h3{{font-family:'Cormorant Garamond',serif;font-weight:600;line-height:1.08}}
  .wrap{{max-width:1180px;margin:0 auto;padding:0 28px}}
  a{{color:inherit;text-decoration:none}}
  .btn{{display:inline-block;padding:15px 34px;border-radius:999px;font-size:.82rem;letter-spacing:.14em;text-transform:uppercase;font-weight:500;transition:.25s;cursor:pointer;border:none}}
  .btn-gold{{background:var(--gold);color:#fff}}
  .btn-gold:hover{{filter:brightness(.93);transform:translateY(-2px)}}
  .btn-ghost{{border:1px solid rgba(255,255,255,.6);color:#fff;background:transparent}}
  .btn-ghost:hover{{background:rgba(255,255,255,.12)}}
  .eyebrow{{font-size:.74rem;letter-spacing:.32em;text-transform:uppercase;color:var(--gold);font-weight:600}}
  .js [data-reveal]{{opacity:0;transform:translateY(28px);transition:opacity .8s ease,transform .8s ease}}
  .js [data-reveal].in{{opacity:1;transform:none}}
  header{{position:fixed;top:0;width:100%;z-index:60;transition:.3s;padding:16px 0}}
  header.scrolled{{background:color-mix(in srgb,var(--cream) 92%,transparent);backdrop-filter:blur(10px);padding:8px 0;box-shadow:0 1px 0 var(--line)}}
  .nav{{display:flex;align-items:center;justify-content:space-between}}
  .logo-img{{height:52px;width:auto;transition:.3s;filter:drop-shadow(0 2px 6px rgba(0,0,0,.45))}}
  header.scrolled .logo-img{{height:44px;filter:none}}
  .logo-txt{{font-family:'Cormorant Garamond',serif;font-size:1.7rem;font-weight:700;letter-spacing:.04em;color:#fff;transition:.3s}}
  header.scrolled .logo-txt{{color:var(--ink)}}
  .logo-txt span{{color:var(--gold)}}
  .links{{display:flex;gap:34px;align-items:center}}
  .links a{{font-size:.8rem;letter-spacing:.1em;text-transform:uppercase;color:rgba(255,255,255,.92)}}
  header.scrolled .links a{{color:var(--ink)}}
  .links a:hover{{color:var(--gold-soft)}}
  header.scrolled .links a:hover{{color:var(--gold)}}
  .nav .btn{{padding:11px 24px}}
  @media(max-width:860px){{.links a:not(.btn){{display:none}}}}
  .hero{{position:relative;min-height:100vh;display:flex;align-items:center;overflow:hidden}}
  .hero-bg{{position:absolute;inset:0;background:url('./assets/hero.jpg') center/cover;animation:kb 24s ease-in-out infinite alternate;will-change:transform}}
  @keyframes kb{{from{{transform:scale(1) translate(0,0)}}to{{transform:scale(1.12) translate(-1.5%,-1.5%)}}}}
  .hero-scrim{{position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.55),rgba(0,0,0,.42))}}
  #particles{{position:absolute;inset:0;z-index:1}}
  .hero-inner{{position:relative;z-index:2;max-width:720px;color:#fff}}
  .hero .eyebrow{{color:var(--gold-soft)}}
  .hero h1{{font-size:clamp(3rem,7vw,5.6rem);margin:18px 0 10px}}
  .hero h1 em{{font-style:italic;color:var(--gold-soft)}}
  .hero p{{font-size:1.12rem;font-weight:300;max-width:520px;margin-bottom:34px;color:rgba(255,255,255,.9)}}
  .hero .cta-row{{display:flex;gap:16px;flex-wrap:wrap}}
  .scroll-cue{{position:absolute;bottom:26px;left:50%;transform:translateX(-50%);z-index:2;color:rgba(255,255,255,.7);font-size:.7rem;letter-spacing:.25em;text-transform:uppercase;animation:bob 2s ease-in-out infinite}}
  @keyframes bob{{0%,100%{{transform:translate(-50%,0)}}50%{{transform:translate(-50%,8px)}}}}
  .strip{{background:var(--ink);color:var(--cream);text-align:center;padding:26px 0}}
  .strip .wrap{{display:flex;justify-content:center;gap:60px;flex-wrap:wrap;font-size:.82rem;letter-spacing:.18em;text-transform:uppercase}}
  .strip span{{color:var(--gold-soft)}}
  section{{padding:108px 0}}
  .sec-head{{text-align:center;max-width:640px;margin:0 auto 64px}}
  .sec-head h2{{font-size:clamp(2.4rem,4.5vw,3.4rem);margin:14px 0}}
  .sec-head p{{color:var(--muted)}}
  .about{{display:grid;grid-template-columns:1fr 1fr;gap:72px;align-items:center}}
  .about-img{{aspect-ratio:4/5;border-radius:8px;background:url('./assets/about.jpg') center/cover;box-shadow:0 30px 60px -30px rgba(0,0,0,.5)}}
  .about h2{{font-size:clamp(2.2rem,4vw,3rem);margin-bottom:8px}}
  .about .eyebrow{{display:block;margin-bottom:6px}}
  .about p{{color:var(--muted);margin:18px 0}}
  .about .sig{{font-family:'Cormorant Garamond',serif;font-size:1.5rem;color:var(--gold)}}
  @media(max-width:820px){{.about{{grid-template-columns:1fr;gap:36px}}.about-img{{aspect-ratio:16/10}}}}
  .services{{background:#fff}}
  .svc-grid{{display:grid;grid-template-columns:repeat(3,1fr);gap:26px}}
  .svc{{border-radius:12px;overflow:hidden;background:var(--cream);box-shadow:0 1px 0 var(--line);transition:.3s}}
  .svc:hover{{transform:translateY(-8px);box-shadow:0 28px 50px -28px rgba(0,0,0,.5)}}
  .svc-img{{height:200px;background-size:cover;background-position:center;position:relative}}
  .svc-img .no{{position:absolute;top:12px;left:14px;font-family:'Cormorant Garamond',serif;font-size:1rem;color:#fff;background:rgba(0,0,0,.5);width:34px;height:34px;border-radius:50%;display:grid;place-items:center;backdrop-filter:blur(3px)}}
  .svc-body{{padding:26px 28px 30px}}
  .svc h3{{font-size:1.6rem;margin-bottom:8px}}
  .svc p{{font-size:.92rem;color:var(--muted)}}
  .svc .price{{margin-top:16px;font-size:.8rem;letter-spacing:.14em;text-transform:uppercase;color:var(--gold);font-weight:600}}
  @media(max-width:820px){{.svc-grid{{grid-template-columns:1fr 1fr}}}}
  @media(max-width:560px){{.svc-grid{{grid-template-columns:1fr}}}}
  .testi{{background:var(--ink);color:var(--cream);text-align:center}}
  .testi .eyebrow{{color:var(--gold-soft)}}
  .testi-track{{display:flex;overflow:hidden;max-width:900px;margin:30px auto 0}}
  .testi-card{{min-width:100%;font-family:'Cormorant Garamond',serif;transition:transform .6s ease}}
  .testi-card q{{font-size:clamp(1.6rem,3vw,2.3rem);font-style:italic;line-height:1.35;display:block;margin-bottom:18px}}
  .testi-card .who{{font-family:'Inter';font-size:.8rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-soft)}}
  .stars{{color:var(--gold-soft);letter-spacing:.3em;margin-bottom:20px}}
  .gallery{{padding-top:0;overflow:hidden}}
  .marquee{{display:flex;gap:16px;width:max-content;animation:scroll 36s linear infinite}}
  .marquee:hover{{animation-play-state:paused}}
  .marquee img{{height:280px;width:340px;object-fit:cover;border-radius:8px}}
  @keyframes scroll{{from{{transform:translateX(0)}}to{{transform:translateX(-50%)}}}}
  .band{{position:relative;color:#fff;text-align:center;overflow:hidden}}
  .band-bg{{position:absolute;inset:0;background:linear-gradient(rgba(0,0,0,.78),rgba(0,0,0,.78)),url('./assets/band.jpg') center/cover}}
  .band .wrap{{position:relative;z-index:1}}
  .band h2{{font-size:clamp(2.4rem,5vw,3.6rem)}}
  .band p{{color:rgba(255,255,255,.85);max-width:520px;margin:14px auto 30px;font-weight:300}}
  footer{{background:var(--ink);color:rgba(255,255,255,.85);padding:80px 0 36px}}
  .foot-grid{{display:grid;grid-template-columns:1.4fr 1fr 1fr;gap:50px;padding-bottom:50px;border-bottom:1px solid rgba(255,255,255,.1)}}
  footer .flogo{{height:58px;margin-bottom:14px}}
  footer .flogo-txt{{font-family:'Cormorant Garamond',serif;font-size:2rem;color:#fff;margin-bottom:14px}}
  footer .flogo-txt span{{color:var(--gold)}}
  footer h4{{font-size:.78rem;letter-spacing:.2em;text-transform:uppercase;color:var(--gold-soft);margin-bottom:16px;font-weight:600}}
  footer p,footer a{{font-size:.95rem;font-weight:300;color:rgba(255,255,255,.8);display:block;margin-bottom:8px}}
  footer a:hover{{color:#fff}}
  .copy{{text-align:center;padding-top:28px;font-size:.78rem;color:rgba(255,255,255,.45)}}
  @media(max-width:760px){{.foot-grid{{grid-template-columns:1fr;gap:32px}}.strip .wrap{{gap:24px}}}}
  .modal{{position:fixed;inset:0;z-index:100;display:none;align-items:center;justify-content:center;background:rgba(0,0,0,.6);backdrop-filter:blur(4px);opacity:0;transition:opacity .35s}}
  .modal.show{{display:flex;opacity:1}}
  .modal-card{{background:var(--cream);max-width:430px;width:92%;border-radius:16px;overflow:hidden;text-align:center;transform:translateY(20px) scale(.97);transition:.4s;box-shadow:0 40px 80px -30px rgba(0,0,0,.6)}}
  .modal.show .modal-card{{transform:none}}
  .modal-top{{background:var(--ink);padding:30px 30px 24px;color:#fff;position:relative}}
  .modal-top .big{{font-family:'Cormorant Garamond',serif;font-size:3.2rem;color:var(--gold-soft);line-height:1}}
  .modal-top .sub{{font-size:.78rem;letter-spacing:.22em;text-transform:uppercase;margin-top:6px;color:rgba(255,255,255,.85)}}
  .modal-body{{padding:28px 32px 34px}}
  .modal-body h3{{font-size:1.9rem;margin-bottom:8px}}
  .modal-body p{{color:var(--muted);font-size:.95rem;margin-bottom:20px}}
  .modal-body input{{width:100%;padding:14px 18px;border:1px solid var(--line);border-radius:999px;font-size:.95rem;margin-bottom:12px;font-family:inherit}}
  .modal-body input:focus{{outline:none;border-color:var(--gold)}}
  .modal-body .btn-gold{{width:100%}}
  .modal-x{{position:absolute;top:12px;right:16px;color:rgba(255,255,255,.7);font-size:1.5rem;cursor:pointer;line-height:1}}
  .modal-x:hover{{color:#fff}}
  .modal .fine{{font-size:.72rem;color:var(--muted);margin-top:14px}}
  .modal .done{{display:none}}.modal.success .form{{display:none}}.modal.success .done{{display:block}}
  .modal.success .done .code{{font-family:'Cormorant Garamond',serif;font-size:2rem;color:var(--gold);letter-spacing:.1em;border:1px dashed var(--gold);border-radius:10px;padding:10px;margin-top:10px}}
  .concept{{position:fixed;bottom:18px;left:18px;z-index:80;background:var(--ink);color:#fff;font-size:.7rem;letter-spacing:.14em;text-transform:uppercase;padding:10px 16px;border-radius:999px;box-shadow:0 10px 30px -10px rgba(0,0,0,.5);border:1px solid rgba(255,255,255,.15)}}
  .concept b{{color:var(--gold-soft);font-weight:600}}
</style>
</head>
<body>
<header id="hdr"><div class="wrap nav">
  <a href="#top">{logo}</a>
  <nav class="links"><a href="#about">About</a><a href="#services">Services</a><a href="#gallery">Gallery</a><a href="#visit">Visit</a><a href="{cta_href}" class="btn btn-gold">{cta}</a></nav>
</div></header>
<section class="hero" id="top">
  <div class="hero-bg"></div><div class="hero-scrim"></div><canvas id="particles"></canvas>
  <div class="wrap hero-inner">
    <span class="eyebrow">{loc_eyebrow}</span>
    <h1>{hero_title}</h1>
    <p>{hero_sub}</p>
    <div class="cta-row"><a href="{cta_href}" class="btn btn-gold">{cta}</a><a href="#services" class="btn btn-ghost">View Services</a></div>
  </div>
  <div class="scroll-cue">Scroll</div>
</section>
<div class="strip"><div class="wrap">{strip}</div></div>
<section id="about"><div class="wrap about">
  <div class="about-img" data-reveal></div>
  <div data-reveal><span class="eyebrow">{about_eyebrow}</span><h2>{about_h2}</h2><p>{about_p1}</p><p>{about_p2}</p><div class="sig">— The {brand} Team</div></div>
</div></section>
<section id="services" class="services"><div class="wrap">
  <div class="sec-head" data-reveal><span class="eyebrow">{svc_eyebrow}</span><h2>{svc_head}</h2><p>{svc_sub}</p></div>
  <div class="svc-grid">{svc_cards}</div>
</div></section>
<section class="testi"><div class="wrap"><span class="eyebrow">Testimonials</span>
  <div class="testi-track" id="testi">{testis}</div>
</div></section>
<section id="gallery" class="gallery"><div class="wrap"><div class="sec-head" data-reveal><span class="eyebrow">Our Work</span><h2>The Gallery</h2></div></div>
  <div class="marquee">{gallery}{gallery}</div>
</section>
<section class="band"><div class="band-bg"></div><div class="wrap">
  <span class="eyebrow" style="color:var(--gold-soft)">{band_eyebrow}</span><h2>{band_head}</h2><p>{band_sub}</p>
  <a href="{cta_href}" class="btn btn-gold">{cta}</a>
</div></section>
<footer id="visit"><div class="wrap"><div class="foot-grid">
  <div>{flogo}<p style="max-width:300px">{foot_blurb}</p></div>
  <div><h4>Visit Us</h4><p>{address}</p>{phone_line}</div>
  <div><h4>Hours</h4>{hours}<a href="{cta_href}" class="btn btn-gold" style="margin-top:12px">{cta}</a></div>
</div><div class="copy">© 2026 {brand}. All rights reserved.</div></div></footer>
<div class="modal" id="promo"><div class="modal-card">
  <div class="modal-top"><span class="modal-x" onclick="closePromo()">&times;</span><div class="big">20% OFF</div><div class="sub">Your First Visit</div></div>
  <div class="modal-body">
    <div class="form"><h3>Join the {brand_short} list</h3><p>Sign up for a 20% off code for your first visit, plus members-only offers.</p>
      <input type="email" id="promoEmail" placeholder="Enter your email" /><button class="btn btn-gold" onclick="submitPromo()">Claim 20% Off</button><div class="fine">No spam. Unsubscribe any time.</div></div>
    <div class="done"><h3>You are in!</h3><p>Show this code at your first visit:</p><div class="code">{code}</div></div>
  </div>
</div></div>
<div class="concept">Redesign concept by <b>Vernon Tech &amp; Media</b></div>
<script>
  document.documentElement.className='js';
  const h=document.getElementById('hdr');let _sc=false;
  const onS=()=>{{const y=window.scrollY||document.documentElement.scrollTop;if(!_sc&&y>90){{_sc=true;h.classList.add('scrolled')}}else if(_sc&&y<50){{_sc=false;h.classList.remove('scrolled')}}}};
  onS();addEventListener('scroll',onS,{{passive:true}});
  const revealAll=()=>document.querySelectorAll('[data-reveal]').forEach(el=>el.classList.add('in'));
  if(location.search.indexOf('shot')>-1){{revealAll();document.querySelector('.hero').style.minHeight='620px';}}
  else{{const io=new IntersectionObserver(es=>es.forEach(e=>{{if(e.isIntersecting)e.target.classList.add('in')}}),{{threshold:.15}});document.querySelectorAll('[data-reveal]').forEach(el=>io.observe(el));}}
  let ti=0;const tc=document.querySelectorAll('#testi .testi-card');if(tc.length>1)setInterval(()=>{{ti=(ti+1)%tc.length;tc.forEach(c=>c.style.transform=`translateX(-${{ti*100}}%)`)}},4500);
  const cv=document.getElementById('particles'),cx=cv.getContext('2d');let W,H,ps=[];
  function rz(){{W=cv.width=cv.offsetWidth;H=cv.height=cv.offsetHeight}}
  function mk(){{ps=Array.from({{length:Math.min(60,Math.floor(W/22))}},()=>({{x:Math.random()*W,y:Math.random()*H,r:Math.random()*2+.4,vy:-(Math.random()*.3+.05),a:Math.random()*.5+.15}}))}}
  function draw(){{cx.clearRect(0,0,W,H);ps.forEach(p=>{{p.y+=p.vy;if(p.y<-5){{p.y=H+5;p.x=Math.random()*W}}cx.beginPath();cx.arc(p.x,p.y,p.r,0,7);cx.fillStyle='rgba({prgb},'+p.a+')';cx.fill()}});requestAnimationFrame(draw)}}
  addEventListener('resize',()=>{{rz();mk()}});rz();mk();draw();
  const M=document.getElementById('promo');
  function openPromo(){{M.classList.add('show')}}
  function closePromo(){{M.classList.remove('show');try{{localStorage.setItem('{slug}_promo','1')}}catch(e){{}}}}
  function submitPromo(){{const e=document.getElementById('promoEmail');if(!e.value||!e.value.includes('@')){{e.focus();e.style.borderColor='#c0392b';return}}M.classList.add('success')}}
  if(!(()=>{{try{{return localStorage.getItem('{slug}_promo')}}catch(e){{return 0}}}})()){{setTimeout(openPromo,6000)}}
  M.addEventListener('click',e=>{{if(e.target===M)closePromo()}});addEventListener('keydown',e=>{{if(e.key==='Escape')closePromo()}});
</script>
</body></html>
"""


def svc_cards(svcs):
    out = []
    for i, (t, d, p, img) in enumerate(svcs, 1):
        out.append(f'<div class="svc" data-reveal><div class="svc-img" style="background-image:url(\'./assets/{img}\')"><div class="no">{i:02d}</div></div><div class="svc-body"><h3>{t}</h3><p>{d}</p><div class="price">{p}</div></div></div>')
    return "".join(out)

def testis(qs):
    return "".join(f'<div class="testi-card"><div class="stars">★★★★★</div><q>{q}</q><div class="who">{who}</div></div>' for q, who in qs)

def gallery(imgs):
    return "".join(f'<img src="./assets/{i}" alt="">' for i in imgs)


def build(cfg):
    slug = cfg["slug"]
    logo = (f'<img class="logo-img" src="./assets/logo.png" alt="{cfg["brand"]}" />' if cfg["logo_img"]
            else f'<span class="logo-txt">{cfg["logo_word"]}<span>.</span></span>')
    flogo = (f'<img class="flogo" src="./assets/logo.png" alt="{cfg["brand"]}" />' if cfg["logo_img"]
             else f'<div class="flogo-txt">{cfg["logo_word"]}<span>.</span></div>')
    html = TPL.format(
        logo=logo, flogo=flogo,
        strip="".join(f'<div><span>&#9733;</span> {s}</div>' for s in cfg["strip"]),
        svc_cards=svc_cards(cfg["services"]), testis=testis(cfg["testis"]),
        gallery=gallery(cfg["gallery"]),
        **{k: v for k, v in cfg.items() if k not in ("strip", "services", "testis", "gallery", "logo_img", "logo_word")},
    )
    (ROOT / slug / "index.html").write_text(html)
    print(f"  built {slug}")


NAIL_HOURS = "<p>Mon – Sat · 9:30am – 7:30pm</p><p>Sunday · 11:00am – 6:00pm</p>"
GAL = ["hero.jpg", "g1.jpg", "g2.jpg", "g3.jpg", "g4.jpg", "about.jpg"]
# six service images cycled from existing assets
SIMG = ["about.jpg", "g1.jpg", "g2.jpg", "g3.jpg", "g4.jpg", "band.jpg"]

CFGS = [
 dict(slug="infinity-nail-spa", brand="Infinity Nail Spa", brand_short="Infinity", code="INFINITY20",
      logo_img=True, logo_word="Infinity", tagline="Endless Kingdom of Beauty · Houston",
      ink="#0f211d", cream="#eef3f0", gold="#bf9d54", goldsoft="#ddc488", muted="#5f6d68", prgb="221,196,136",
      meta="Infinity Nail Spa, a cozy beauty boutique in Houston 77027 offering high-class nail and spa services.",
      loc_eyebrow="Houston, TX 77027", hero_title="An endless kingdom of <em>beauty</em>",
      hero_sub="A cozy beauty boutique offering high-class nail and spa services, made to embellish and nourish your beauty from the inside out.",
      cta="Book Now", cta_href="tel:7134922547",
      strip=["High-class nail care","Clean &amp; cozy boutique","Walk-ins welcome"],
      about_eyebrow="About Us", about_h2="Beauty, nourished from within",
      about_p1="Infinity Nail Spa is a cozy beauty boutique in Houston 77027 offering high-class nail and spa services, aiming to embellish and nourish your beauty from the inside out.",
      about_p2="From acrylic, dip powder, and gel to relaxing spa treatments, our team delivers a clean, welcoming experience every visit.",
      svc_eyebrow="What We Offer", svc_head="Our Services", svc_sub="Full-range nail beauty and spa care.",
      services=[("Manicure","Classic and luxury manicures finished to perfection.","From $20",SIMG[0]),
                ("Pedicure","Relaxing spa pedicures from soak to massage.","From $35",SIMG[1]),
                ("Acrylic &amp; Extensions","Full-set acrylic and extensions in any shape.","From $45",SIMG[2]),
                ("Dip Powder","Long-lasting, lightweight dip powder color.","From $40",SIMG[3]),
                ("Gel Polish","Glossy, chip-resistant gel that lasts for weeks.","From $30",SIMG[4]),
                ("Waxing","Gentle, precise waxing services.","From $12",SIMG[5])],
      testis=[("This place is so awesome. I have been coming here since the week they opened and absolutely love it. Very clean and amazing staff.","Mallory L."),
              ("Always a great experience and the place I recommend to anyone looking for a new spot to try.","Infinity Guest"),
              ("High-class service in a cozy, spotless setting. My nails have never looked better.","Infinity Guest")],
      gallery=GAL, band_eyebrow="Ready when you are", band_head="Come find your shine",
      band_sub="A great experience every visit, just like our regulars say. Book your appointment today.",
      foot_blurb="A cozy beauty boutique in Houston, the endless kingdom of beauty.",
      address="Houston, TX 77027", phone_line='<a href="tel:7134922547">(713) 492-2547</a>', hours=NAIL_HOURS),

 dict(slug="plush-nail-bar", brand="Plush Nail Bar", brand_short="Plush", code="PLUSH20",
      logo_img=False, logo_word="Plush", tagline="A Full-Service Nail Salon",
      ink="#14130f", cream="#f5f1e8", gold="#d4af37", goldsoft="#ecd58a", muted="#736d63", prgb="236,213,138",
      meta="Plush Nail Bar, a full-service nail salon serving Kingwood, The Woodlands and beyond since 2017.",
      loc_eyebrow="Kingwood · The Woodlands · Bellaire", hero_title="Get your <em>shine</em> on",
      hero_sub="A full-service nail salon here just for you. Since 2017 we have been making our customers look stunning and feel their best.",
      cta="Book Online", cta_href="https://plushnailbarus.com/",
      strip=["Full-service nail bar","Multiple Houston locations","Quality &amp; professionalism"],
      about_eyebrow="Welcome to Plush", about_h2="Look stunning, feel your best",
      about_p1="Since April 2017, Plush Nail Bar has grown to be one of the most prominent spots in the Houston area, guaranteeing quality and professionalism to every customer.",
      about_p2="Over the years we have stayed committed to making our devoted customers look stunning and feel their best across all our locations.",
      svc_eyebrow="What We Offer", svc_head="Our Treatments", svc_sub="A complete menu of nail care across all our locations.",
      services=[("Manicure","Classic and gel manicures for a flawless finish.","From $22",SIMG[0]),
                ("Pedicure","Indulgent spa pedicures that melt the day away.","From $38",SIMG[1]),
                ("Nail Enhancements","Acrylic, gel, and dip full sets and fills.","From $45",SIMG[2]),
                ("Gel &amp; Dip","Durable, long-wearing color that keeps its shine.","From $35",SIMG[3]),
                ("Gift Cards","The perfect gift for someone who deserves it.","Any amount",SIMG[4]),
                ("Waxing","Clean, comfortable waxing services.","From $12",SIMG[5])],
      testis=[("One of the most prominent nail spots in the area for a reason. Always stunning work.","Plush Guest"),
              ("Qualified, professional, and so welcoming. I will not go anywhere else.","Plush Guest"),
              ("Beautiful salon and beautiful results every single time.","Plush Guest")],
      gallery=GAL, band_eyebrow="Ready when you are", band_head="Book your visit",
      band_sub="Locations across The Woodlands, Kingwood, Bellaire and more. Reserve your spot online.",
      foot_blurb="A full-service nail salon serving the Houston area since 2017.",
      address="Kingwood &amp; multiple<br>Houston-area locations",
      phone_line='<a href="https://plushnailbarus.com/">View locations</a>', hours=NAIL_HOURS),

 dict(slug="milano-nail-spa", brand="Milano Nail Spa", brand_short="Milano", code="MILANO20",
      logo_img=False, logo_word="Milano", tagline="Best Nail Salon in Meyerland, Houston",
      ink="#21121a", cream="#f6ece9", gold="#c98b6b", goldsoft="#e3b59b", muted="#7a6a70", prgb="227,181,155",
      meta="Milano Nail Spa Meyerland, the best service nail salon in Houston. Walk-ins and appointments welcome.",
      loc_eyebrow="Meyerland Plaza · Houston, TX", hero_title="Relax, refresh, <em>renew</em>",
      hero_sub="It is our pleasure to provide a comfortable and friendly place where you can truly relax and be pampered.",
      cta="Book Now", cta_href="tel:2819742904",
      strip=["Walk-ins &amp; appointments","Online booking available","Complimentary drink"],
      about_eyebrow="Our Goals", about_h2="A place to truly relax",
      about_p1="At Milano Nail Spa Meyerland it is our pleasure to provide you with a comfortable and friendly place where you can truly relax and be pampered.",
      about_p2="We are committed to delivering services that keep you looking and feeling your best, with the latest trends and the highest standards of sanitation.",
      svc_eyebrow="What We Offer", svc_head="Our Services", svc_sub="A complete menu of nail, waxing, and beauty services.",
      services=[("Pedicure","Spa pedicures designed to relax and restore.","From $35",SIMG[0]),
                ("Manicure","Classic, shellac, and luxury manicures.","From $20",SIMG[1]),
                ("Nail Enhancements","Acrylic and dipping powder full sets.","From $45",SIMG[2]),
                ("Shellac Manicure","Glossy, long-lasting shellac color.","From $30",SIMG[3]),
                ("Eyelash Extensions","Full, natural-looking lash extensions.","From $80",SIMG[4]),
                ("Waxing &amp; Facial","Waxing services and refreshing facial treatments.","From $15",SIMG[5])],
      testis=[("The best service nail salon in Houston, hands down. Always happy when I leave.","Milano Guest"),
              ("Comfortable, friendly, and so relaxing. They really do pamper you.","Milano Guest"),
              ("Great promotions and even better service. My go-to in Meyerland.","Milano Guest")],
      gallery=GAL, band_eyebrow="Happy deals &amp; great promotions", band_head="Come get pampered",
      band_sub="Walk-ins and appointments are always welcome. Online booking is available too.",
      foot_blurb="The best service nail salon in Meyerland, Houston.",
      address="Meyerland Plaza Mall<br>Houston, TX 77096", phone_line='<a href="tel:2819742904">(281) 974-2904</a>', hours=NAIL_HOURS),

 dict(slug="sofia-grace-nails", brand="Sofia Grace Nail Boutique", brand_short="Sofia Grace", code="SOFIA20",
      logo_img=True, logo_word="Sofia Grace", tagline="Your Definition of Beauty · Houston",
      ink="#161413", cream="#f4eeea", gold="#c2998c", goldsoft="#ddbcb1", muted="#776e69", prgb="221,188,177",
      meta="Sofia Grace Nail Boutique, a tranquil Houston nail salon where elegance and satisfaction come first.",
      loc_eyebrow="Houston, TX", hero_title="Your style, your <em>definition</em> of beauty",
      hero_sub="A tranquil, relaxing, and pleasing environment that is all about you. Customer service is our mission.",
      cta="Book Now", cta_href="tel:7139612686",
      strip=["Tranquil boutique setting","Medically sterilized tools","Latest fashion trends"],
      about_eyebrow="About Us", about_h2="Elegance and satisfaction, first",
      about_p1="Welcome to Sofia Grace Nail Boutique, where your elegance and satisfaction are our main priority. Our salon is a tranquil, relaxing, and pleasing environment that is all about you.",
      about_p2="Our motivated team are highly qualified experts who keep up with the latest trends. Safety and sanitation are key, so our instruments are medically sterilized and disinfected.",
      svc_eyebrow="What We Offer", svc_head="Signature Services", svc_sub="Refined nail care in a tranquil setting.",
      services=[("Manicure","Elegant manicures finished with precision.","From $22",SIMG[0]),
                ("Pedicure","Restorative spa pedicures, start to finish.","From $38",SIMG[1]),
                ("Nail Enhancement","Acrylic, gel, and extensions tailored to you.","From $48",SIMG[2]),
                ("Kids","A gentle, fun experience for little ones.","From $18",SIMG[3]),
                ("Waxing","Smooth, careful waxing services.","From $12",SIMG[4]),
                ("Add-Ons","Finishing touches to elevate any service.","Varies",SIMG[5])],
      testis=[("Truly a tranquil escape. Elegant work and the kindest team in Houston.","Sofia Grace Guest"),
              ("Pampered from the moment I walked in. My definition of beauty, exactly.","Sofia Grace Guest"),
              ("Spotless, relaxing, and beautiful results. I always leave glowing.","Sofia Grace Guest")],
      gallery=GAL, band_eyebrow="Ready when you are", band_head="Define your beauty",
      band_sub="Be pampered by professional technicians in a setting built around you. Book today.",
      foot_blurb="A tranquil Houston nail boutique built around your elegance and satisfaction.",
      address="Houston, TX", phone_line='<a href="tel:7139612686">(713) 961-2686</a>', hours=NAIL_HOURS),

 dict(slug="dripped-nails", brand="Dripped Nails &amp; Spa", brand_short="Dripped", code="DRIPPED20",
      logo_img=False, logo_word="Dripped", tagline="Best Nail Spa in Midtown Houston",
      ink="#16131a", cream="#f3eef1", gold="#c79a54", goldsoft="#e3c892", muted="#776e74", prgb="227,200,146",
      meta="Dripped Nails and Spa, your sanctuary of tranquility in Midtown Houston. Gel X, dip powder, manicures and pedicures.",
      loc_eyebrow="Midtown · Houston, TX", hero_title="Your sanctuary of <em>tranquility</em>",
      hero_sub="Dripped Nails and Spa is proud to be one of the best nail spas in Midtown. Step in and let us take care of the rest.",
      cta="Book Now", cta_href="tel:7138148189",
      strip=["Best nail spa in Midtown","Clean &amp; serene setting","Walk-ins welcome"],
      about_eyebrow="About Us", about_h2="A sanctuary in Midtown",
      about_p1="Dripped Nails and Spa is proud to be one of the best nail spas in Midtown Houston, a sanctuary of tranquility and serenity built around you.",
      about_p2="From Gel X and soft gel to dip powder, manicures, and pedicures, our team delivers a clean, relaxing experience every visit.",
      svc_eyebrow="What We Offer", svc_head="Our Services", svc_sub="A full menu of modern nail care.",
      services=[("Gel X &amp; Soft Gel","Lightweight, natural-looking gel extensions and overlays.","From $50",SIMG[0]),
                ("Manicure","Classic and luxury manicures finished to perfection.","From $22",SIMG[1]),
                ("Pedicure","Relaxing spa pedicures from soak to massage.","From $38",SIMG[2]),
                ("Dip Powder","Long-lasting, lightweight dip powder color.","From $45",SIMG[3]),
                ("Acrylic &amp; Extensions","Full-set acrylic and extensions in any shape.","From $48",SIMG[4]),
                ("Waxing","Gentle, precise waxing services.","From $12",SIMG[5])],
      testis=[("The best nail spa in Midtown, hands down. Truly a tranquil escape every visit.","Dripped Guest"),
              ("Spotless, serene, and the gel work lasts for weeks. My go-to in Houston.","Dripped Guest"),
              ("A real sanctuary. Kind staff, beautiful results, and a calm setting.","Dripped Guest")],
      gallery=GAL, band_eyebrow="Ready when you are", band_head="Come find your calm",
      band_sub="Step into your sanctuary of tranquility. Book your appointment today.",
      foot_blurb="Your sanctuary of tranquility and serenity in Midtown Houston.",
      address="Midtown<br>Houston, TX", phone_line='<a href="tel:7138148189">713-814-8189</a>', hours=NAIL_HOURS),

 dict(slug="palazzio-nail", brand="Palazzio Nail Lounge", brand_short="Palazzio", code="PALAZZIO20",
      logo_img=True, logo_word="Palazzio", tagline="Luxury Nail Salon in River Oaks, Houston",
      ink="#141210", cream="#f4efe7", gold="#c2a14e", goldsoft="#e6cd8e", muted="#776e63", prgb="230,205,142",
      meta="Palazzio Nail Lounge, a luxury nail salon in River Oaks, Houston. Pedicures, manicures, enhancements, lashes and facials.",
      loc_eyebrow="River Oaks · Houston, TX", hero_title="Luxury, down to your <em>fingertips</em>",
      hero_sub="A luxury nail lounge in the heart of River Oaks. Indulge in beautiful nails and a setting designed entirely around you.",
      cta="Book Now", cta_href="tel:7139422525",
      strip=["River Oaks luxury lounge","Clean &amp; elevated setting","By appointment or walk-in"],
      about_eyebrow="About Us", about_h2="An elevated nail experience",
      about_p1="Palazzio Nail Lounge is a luxury nail salon in River Oaks, Houston, where every detail is designed to make you feel pampered and at ease.",
      about_p2="From pedicures and manicures to enhancements, lashes, and facials, our team delivers a refined experience worthy of the neighborhood.",
      svc_eyebrow="Our Services", svc_head="Signature Services", svc_sub="A full menu of luxury nail and beauty care.",
      services=[("Pedicures","Indulgent spa pedicures in a luxurious setting.","From $40",SIMG[0]),
                ("Manicures","Classic and gel manicures finished to perfection.","From $25",SIMG[1]),
                ("Nail Enhancement","Acrylic, gel, and extensions tailored to you.","From $50",SIMG[2]),
                ("Eyelash Extensions","Full, natural-looking lashes by our specialists.","From $90",SIMG[3]),
                ("Waxing &amp; Facial","Smooth waxing and refreshing facial treatments.","From $15",SIMG[4]),
                ("Kids Services","A gentle, fun experience for little ones.","From $20",SIMG[5])],
      testis=[("The most luxurious nail experience in River Oaks. Spotless, elegant, and worth every minute.","Palazzio Guest"),
              ("Pampered from start to finish. The setting alone is worth the visit.","Palazzio Guest"),
              ("Beautiful work and incredible attention to detail. My new go-to.","Palazzio Guest")],
      gallery=GAL, band_eyebrow="Ready when you are", band_head="Indulge yourself today",
      band_sub="Treat yourself to a little luxury in River Oaks. Book your appointment today.",
      foot_blurb="A luxury nail lounge in the heart of River Oaks, Houston.",
      address="River Oaks<br>Houston, TX", phone_line='<a href="tel:7139422525">(713) 942-2525</a>', hours=NAIL_HOURS),

 dict(slug="dorado-nail", brand="Dorado Nail Bar", brand_short="Dorado", code="DORADO20",
      logo_img=True, logo_word="Dorado", tagline="Best Nail Salon in Houston, TX 77025",
      ink="#171205", cream="#f5f0e4", gold="#d4af37", goldsoft="#ecd58a", muted="#766f5e", prgb="236,213,138",
      meta="Dorado Nail Bar in Houston 77025. Simply glamour. Professional nail care to enhance your natural beauty.",
      loc_eyebrow="Houston, TX 77025", hero_title="Simply <em>glamour</em>",
      hero_sub="Nail polish to enhance your beauty. Nestled in the heart of the city, Dorado Nail Bar is your place to create your style.",
      cta="Book Now", cta_href="tel:3466922324",
      strip=["Professional nail care","Create your own style","Come and experience"],
      about_eyebrow="About Us", about_h2="Create your style with us",
      about_p1="Nestled in the heart of the city, Dorado Nail Bar in Houston 77025 is a professional nail salon dedicated to enhancing your natural beauty.",
      about_p2="From classic manicures to bold enhancements, our team helps you create a look that is simply glamour, every single visit.",
      svc_eyebrow="Our Services", svc_head="Our Services", svc_sub="A full menu of nail care, your way.",
      services=[("Manicures","Classic, gel, and luxury manicures done right.","From $22",SIMG[0]),
                ("Pedicures","Relaxing spa pedicures from soak to finish.","From $38",SIMG[1]),
                ("Nail Enhancement","Acrylic and gel full sets in any style.","From $45",SIMG[2]),
                ("Dipping Powder","Lightweight, long-lasting dip powder color.","From $40",SIMG[3]),
                ("Waxing","Clean, comfortable waxing services.","From $12",SIMG[4]),
                ("Add-Ons","Designs and finishing touches to make it yours.","Varies",SIMG[5])],
      testis=[("Simply glamour, every time. The detail and care here is unmatched.","Dorado Guest"),
              ("A real gem in Houston. Beautiful work and the friendliest team.","Dorado Guest"),
              ("I always leave feeling glamorous. My favorite nail bar in the city.","Dorado Guest")],
      gallery=GAL, band_eyebrow="Do come and experience", band_head="Create your style today",
      band_sub="Come experience the Dorado difference. Book your appointment today.",
      foot_blurb="Simply glamour. A professional nail bar in the heart of Houston.",
      address="Houston, TX 77025", phone_line='<a href="tel:3466922324">(346) 692-2324</a>', hours=NAIL_HOURS),

 dict(slug="pretty-nails", brand="Pretty Nails &amp; Lashes", brand_short="Pretty Nails", code="PRETTY20",
      logo_img=True, logo_word="Pretty", tagline="Nail Salon in Houston, TX 77067",
      ink="#1b1318", cream="#f6eef1", gold="#c98ba0", goldsoft="#e6bccb", muted="#7a6c72", prgb="230,188,203",
      meta="Pretty Nails and Lashes, a trendy nail salon in Houston 77067 offering manicures, pedicures, lashes and more.",
      loc_eyebrow="Houston, TX 77067", hero_title="Look and feel <em>pretty</em>",
      hero_sub="A trendy nail salon offering a wide array of services, from manicures and pedicures to lash extensions and more.",
      cta="Book Now", cta_href="tel:3464468420",
      strip=["Trendy nail salon","Nails &amp; lashes","Wide array of services"],
      about_eyebrow="About Us", about_h2="Where pretty comes standard",
      about_p1="Pretty Nails and Lashes is a trendy nail salon in Houston offering a wide array of services, including manicures, pedicures, lashes, and more.",
      about_p2="Our team keeps up with the latest trends so you always leave looking and feeling your prettiest.",
      svc_eyebrow="Our Services", svc_head="Service Menu", svc_sub="Everything you need to look and feel pretty.",
      services=[("Manicures","Classic and gel manicures with a flawless finish.","From $20",SIMG[0]),
                ("Pedicures","Relaxing spa pedicures, start to finish.","From $35",SIMG[1]),
                ("Nail Enhancement","Acrylic, gel, and dip full sets and fills.","From $45",SIMG[2]),
                ("Lash Extensions","Full, fluttery lash sets by our specialists.","From $80",SIMG[3]),
                ("Waxing","Smooth, careful waxing services.","From $12",SIMG[4]),
                ("Kids","A gentle, fun experience for little ones.","From $18",SIMG[5])],
      testis=[("Always leave feeling pretty. Trendy designs and the sweetest staff.","Pretty Nails Guest"),
              ("My nails and lashes have never looked better. Highly recommend.","Pretty Nails Guest"),
              ("Clean, friendly, and on top of every trend. My regular spot now.","Pretty Nails Guest")],
      gallery=GAL, band_eyebrow="Ready when you are", band_head="Come get pretty",
      band_sub="Nails, lashes, and everything in between. Book your appointment today.",
      foot_blurb="A trendy Houston nail and lash salon where pretty comes standard.",
      address="Houston, TX 77067", phone_line='<a href="tel:3464468420">(346) 446-8420</a>', hours=NAIL_HOURS),
]


def main():
    for c in CFGS:
        build(c)
    print("Done.")

if __name__ == "__main__":
    main()
