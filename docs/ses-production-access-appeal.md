# SES production access appeal (case 179269796600754)

The first request (2026-10-22) came back with AWS's automated "additional
information needed" message. Reply in the case with the text below, in one
message. Do not open a second request while the case is open.

Verified identity in us-east-2 at the time of reply: `mail.scalesolo.ai`
(DKIM SUCCESS, MAIL FROM SUCCESS) plus `ray@vernontm.com`.

---

Hello,

Here is the information requested, for account 063280428943 in us-east-2.

**Website or application URL**
https://scalesolo.ai. ScaleSolo is a marketing platform built by Vernon Tech and Media for small local businesses and creators (restaurants, service businesses, personal brands). Customers use it to schedule social posts and to email their own subscriber lists. Our verified sending identity in this region is mail.scalesolo.ai, with DKIM and a custom MAIL FROM (bounce.mail.scalesolo.ai) both verified, and a DMARC record published on scalesolo.ai.

**Email type**
Marketing. Newsletters, weekly specials, event announcements, and welcome messages, each written and approved by the business owner in our composer before it is sent to that business's own subscribers. We do not send cold outreach. Transactional product email (receipts, invitations) is handled by a separate provider and is not part of this request.

**Volume**
Under 20,000 recipients per month to start, roughly 300 to 700 per day with peaks on days a business sends a newsletter. Growth follows our customer count. Sends are paced server-side at a fixed rate and a campaign can never reach the same contact twice (enforced by a database uniqueness constraint).

**Recipient source**
Three ways only, all opt-in:
1. The recipient submits a sign-up or lead form on the business's landing page, hosted by us, which records the consent time, source, and IP.
2. The recipient signs up in person (for example a restaurant's loyalty list) and the business owner enters them.
3. The business imports a CSV of its existing subscribers and confirms during import that those people opted in.
Purchased, rented, or scraped lists are prohibited by our terms and there is no feature for them. Lists are never shared between customers. Every message carries a one-click unsubscribe link and List-Unsubscribe plus List-Unsubscribe-Post headers; unsubscribes take effect immediately and are checked before every single send.

**Bounce and complaint handling**
The SES configuration set publishes BOUNCE, COMPLAINT, DELIVERY, REJECT, OPEN, and CLICK events to an SNS topic that our signature-verified HTTPS webhook consumes (this path is already live and tested). A permanent bounce or any complaint immediately adds the address to a platform-wide suppression table, marks the contact as bounced or complained so it is excluded from every future audience, and updates the campaign's dashboard counters. The SES account-level suppression list is also enabled for bounces and complaints. Transient bounces are logged and not retried. A message SES refuses is recorded as failed and is never automatically retried. We monitor bounce and complaint rates per campaign in the product and will pause a customer whose complaint rate approaches 0.1 percent.

**Sample email**
Subject: This Sunday: the family platter is back
Preview: Chicken shawarma, kafta, and lamb chops for the whole table.

Hi {{first_name}},

The family platter is back on the menu this Sunday only: chicken shawarma, beef shawarma, kafta, and lamb chops with rice, hummus, and fresh bread for four.

Call ahead or order online and we will have it ready when you arrive.

[Reserve a table]

Sanabreh Mediterranean Restaurant
487 Bay Area Blvd, Houston, TX
You are receiving this because you signed up for updates from Sanabreh. Unsubscribe

(The footer with the business name, postal address, and unsubscribe link is added by our system to every message and cannot be removed by the customer.)

Thank you for taking another look.
