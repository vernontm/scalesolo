# SES production access appeal (case 179269796600754)

The first request (2026-10-22) was denied. AWS does not say why over the
API; the reason is in the Support Center case. Open AWS Support Center,
find the case, and reply with the text below (edit anything that is not
accurate). If the case is closed, open a new "Service limit increase" case
for SES sending limits and paste the same text, referencing the old case.

Do not resubmit through the API or the SES console form while this is
open. A second request while one is pending returns a conflict, and a
fresh form submission starts the clock over without the context below.

---

Hello,

We are requesting production access for Amazon SES in us-east-2 (account
063280428943), following the denial of case 179269796600754. Here is the
detail that request may have been missing.

Who we are. ScaleSolo (https://scalesolo.ai) is a marketing platform built
by Vernon Tech and Media for small local businesses and creators. Our
customers (restaurants, service businesses, personal brands) use it to
schedule social posts and to email their own subscriber lists.

What we send. Marketing email on behalf of those customers to their own
subscribers: newsletters, weekly specials, event announcements, and
welcome messages. Every campaign is written and approved by the customer
in our composer before it goes out. We do not send cold outreach, and we
do not sell, rent, or share lists between customers.

How recipients get on a list. Three ways only: (1) they submit a sign-up
or lead form on the customer's landing page, hosted by us, which records
the time, source, and IP of consent; (2) they sign up in person (for
example a restaurant's loyalty sheet) and the customer enters them; (3)
the customer imports a CSV of their existing subscribers and confirms
during import that those people opted in. Purchased or scraped lists are
prohibited by our terms and there is no feature for them.

How recipients get off a list. Every message carries a one-click
unsubscribe link in the footer and List-Unsubscribe plus
List-Unsubscribe-Post headers, so Gmail and Yahoo show their native
unsubscribe button. Unsubscribes take effect immediately: the address is
written to a suppression table that the sending worker checks before
every single send.

Bounces and complaints. The SES configuration set publishes BOUNCE,
COMPLAINT, DELIVERY, REJECT and other events to an SNS topic that our
signed webhook consumes. A permanent bounce or any complaint suppresses
the address across all customers on the platform, marks the contact as
bounced or complained so it is excluded from future audiences, and
updates the campaign's stats. The account-level suppression list is also
enabled for bounces and complaints. Transient bounces are logged and not
retried. A message that SES refuses is recorded as failed and never
automatically retried.

Volume. Under 20,000 recipients per month to start, growing with customer
count. Sends are paced server-side (currently 8 per second) and a
campaign is never sent twice to the same contact (enforced by a database
uniqueness constraint).

Authentication. The sending domain mail.scalesolo.ai is verified with
Easy DKIM (2048-bit) and a custom MAIL FROM (bounce.mail.scalesolo.ai),
and a DMARC policy is published on scalesolo.ai. Customers who want to
send from their own domain verify it the same way (DKIM plus custom MAIL
FROM) inside our product before any mail leaves on that domain.

Compliance. Every message includes the sending business's name and postal
address, and we comply with CAN-SPAM. Our terms require customers to send
only to people who have asked for their mail.

Thank you for taking another look.
