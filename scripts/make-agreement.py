#!/usr/bin/env python3
"""
Generate a Sanabreh Phase 1 Content Collaboration Agreement as a PDF.

- Creator full-name field is FILLABLE (typed).
- Both signature + date lines are blank RULED LINES for real ink (not fillable).
- Sanabreh side pre-fills "Ray / Outreach Manager"; sign by hand after generating.

Usage:
    python3 scripts/make-agreement.py \
        --creator "Tiffany" --handle tiffanytiannaa \
        --email collabwithtiffanytv@gmail.com \
        --visit "Friday, June 5, 2026, 6:30 PM" \
        --out "/tmp/Sanabreh-Tiffany-Agreement.pdf"

Then Ray signs the Sanabreh line, and it's ready to attach for the creator to
complete. Defaults match the current Phase 1 trial terms (comp = one meal, one
drink, hookah; 7-day post-or-reimburse; 12-month usage license).
"""
import argparse
from reportlab.lib.pagesizes import letter
from reportlab.pdfgen import canvas
from reportlab.lib.utils import simpleSplit

ADDRESS = "487 Bay Area Blvd, Houston, TX"


def build(out, creator, handle, email_addr, visit, comp, usage_months):
    c = canvas.Canvas(out, pagesize=letter)
    W, H = letter
    L = 72; R = W - 72; TOP = H - 72; BOT = 72
    y = [TOP]

    def newpage():
        c.showPage(); y[0] = TOP

    def block(txt, size=10.5, leading=14.5, indent=0, space_after=7, bold=False):
        font = 'Helvetica-Bold' if bold else 'Helvetica'
        for ln in simpleSplit(txt, font, size, R - L - indent):
            if y[0] < BOT + 30: newpage()
            c.setFont(font, size); c.drawString(L + indent, y[0], ln); y[0] -= leading
        y[0] -= space_after

    def heading(txt, size=11.5):
        if y[0] < BOT + 46: newpage()
        y[0] -= 3
        c.setFont('Helvetica-Bold', size); c.drawString(L, y[0], txt); y[0] -= size + 5

    c.setFont('Helvetica-Bold', 16); c.drawCentredString(W/2, y[0], 'SANABREH RESTAURANT'); y[0] -= 21
    c.setFont('Helvetica', 11); c.drawCentredString(W/2, y[0], 'Content Collaboration Agreement  (Phase 1 Trial)'); y[0] -= 10
    c.setLineWidth(0.6); c.line(L, y[0], R, y[0]); y[0] -= 20

    block(f'Effective date: {visit.split(",")[0]} {visit.split(",")[1].strip()}, {visit.split(",")[2].strip()}' if visit.count(",") >= 2 else 'Effective date: ____________', bold=True, space_after=10)
    block('Between:', bold=True, space_after=2)
    block(f'Sanabreh Restaurant ("Sanabreh"), {ADDRESS}.')
    block(f'{creator} / @{handle} ("Creator"), email: {email_addr}.', space_after=8)
    block(f'Scheduled visit: {visit} at Sanabreh.', bold=True, space_after=10)

    heading('1. Deliverables (Phase 1 Trial)')
    for b in [
        'One (1) original short-form video, 60 to 90 seconds, featuring Sanabreh and its food, with full creative freedom on style and concept.',
        f'Published as a collaboration post linking both the Creator’s TikTok (@{handle}) and Sanabreh’s TikTok (@sanabreh, tiktok.com/@sanabreh), so it appears on both accounts, and also to the Creator’s Instagram. The TikTok must be set up as a Collab post with the Sanabreh account.',
        'The Creator will reshare the content to their story at least once per week for the 30-day trial period.',
        'The Creator will include a Sanabreh tracking link in story reshares and mention a provided reservation code in the video.',
        'The video must be posted within seven (7) days of the visit.']:
        block('•  ' + b, indent=12, space_after=4)
    y[0] -= 4

    heading('2. Compensation & Posting Requirement (Phase 1)')
    block(f'A complimentary dining experience for the Creator: {comp}. Phase 1 is a trial and carries no monetary compensation.', indent=12, space_after=5)
    block('The complimentary items are provided strictly on the condition that the Creator publishes the agreed content within seven (7) days of the visit. If the Creator fails to post the content within seven (7) days, the Creator becomes responsible for, and agrees to reimburse Sanabreh for, the full retail value of all comped items and any other charges incurred during the visit.', indent=12)

    heading('3. Performance Evaluation & Phase 2')
    block('Sanabreh will evaluate performance over 30 days (views, watch time, engagement, reach, traffic, and reservations). If results meet expectations, the parties may enter a separate paid Phase 2 agreement, with rates based on demonstrated performance.', indent=12)

    heading('4. Content Usage Rights')
    block(f'The Creator grants Sanabreh a non-exclusive, royalty-free license to use, edit, repurpose, repost, and display the content across Sanabreh’s marketing channels, including organic social media, the Sanabreh website, and paid advertising and promotions, for a period of {usage_months} ({_num(usage_months)}) months from the date the content is posted. The Creator retains full ownership of the content and may keep it on their own channels. Any use beyond {usage_months} months will be mutually agreed in writing.', indent=12)

    heading('5. Creative Control')
    block('The Creator has full creative freedom. Sanabreh may request reasonable revisions only for factual accuracy or brand safety.', indent=12)

    heading('6. Disclosure')
    block('The Creator will clearly disclose the collaboration in line with FTC guidelines (for example, a "paid partnership" label or a gifting disclosure such as #ad).', indent=12)

    heading('7. Independent Contractor')
    block('The Creator is an independent contractor, not an employee of Sanabreh, and is responsible for their own taxes.', indent=12)

    heading('8. General')
    block('This is the entire agreement between the parties for the Phase 1 trial and is governed by the laws of the State of Texas.', indent=12, space_after=14)

    if y[0] < 210: newpage()
    heading('Signatures')
    af = c.acroForm

    def sigline(x1, x2, yy):
        c.setLineWidth(0.6); c.line(x1, yy, x2, yy)

    c.setFont('Helvetica-Bold', 10.5); c.drawString(L, y[0], 'Sanabreh Restaurant'); y[0] -= 16
    c.setFont('Helvetica', 10.5); c.drawString(L, y[0], 'Name: Ray'); c.drawString(L+150, y[0], 'Title: Outreach Manager'); y[0] -= 26
    c.drawString(L, y[0], 'Signature:'); sigline(L+60, L+300, y[0]-1)
    c.drawString(L+320, y[0], 'Date:'); sigline(L+352, R, y[0]-1)
    y[0] -= 34
    c.setFont('Helvetica-Bold', 10.5); c.drawString(L, y[0], 'Creator'); y[0] -= 18
    c.setFont('Helvetica', 10.5); c.drawString(L, y[0], 'Full legal name:')
    af.textfield(name='creator_name', x=L+95, y=y[0]-4, width=300, height=15, borderStyle='underlined', forceBorder=True, fontName='Helvetica', fontSize=10)
    y[0] -= 28
    c.drawString(L, y[0], 'Signature:'); sigline(L+60, L+300, y[0]-1)
    c.drawString(L+320, y[0], 'Date:'); sigline(L+352, R, y[0]-1)

    c.save()


def _num(n):
    words = {6: 'six', 12: 'twelve', 18: 'eighteen', 24: 'twenty-four'}
    return words.get(int(n), str(n))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--creator', required=True, help='Creator display name, e.g. "Tiffany"')
    ap.add_argument('--handle', required=True, help='TikTok handle without @')
    ap.add_argument('--email', required=True)
    ap.add_argument('--visit', required=True, help='e.g. "Friday, June 5, 2026, 6:30 PM"')
    ap.add_argument('--comp', default='one meal, one drink, and hookah at the scheduled visit')
    ap.add_argument('--usage-months', type=int, default=12)
    ap.add_argument('--out', required=True)
    args = ap.parse_args()
    build(args.out, args.creator, args.handle, args.email, args.visit, args.comp, args.usage_months)
    print('Created', args.out)


if __name__ == '__main__':
    main()
