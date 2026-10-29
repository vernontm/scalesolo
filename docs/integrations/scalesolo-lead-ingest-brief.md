# Brief: send leads into a ScaleSolo email list

Hand this file to a session working on the thing that will be sending leads
(a client's website, a backend, a CRM, an automation tool). It is
self-contained: you do not need the ScaleSolo codebase to do this work, and
you should not need to ask questions before starting.

## The job

Make the system you are working on POST each new lead or customer to
ScaleSolo, so they land on the right brand's email list and start the right
email sequence.

## The endpoint

```
POST https://www.scalesolo.ai/api/email/subscribe
x-api-key: <the brand key>
content-type: application/json
```

```json
{
  "email": "jane@example.com",
  "name": "Jane Doe",
  "phone": "+15551234567",
  "tags": ["newsletter"],
  "source": "website-footer"
}
```

Only `email` is required. A success looks like:

```json
{ "ok": true, "contact_id": "6f2c...", "created": true }
```

## Getting the key

Ray creates it: ScaleSolo, Email page, Sender tab, "Add leads from anywhere",
Create key. It is shown once and cannot be read back, because only a hash of
it is stored.

A key is tied to ONE brand. Whichever brand the key belongs to is the list the
lead joins, so there is no brand or account id to send. If you are wiring up
two brands, you need two keys.

## Which brand a lead goes to

**The key decides, and nothing else.** There is no brand field, no account id
and no brand name anywhere in the request. The server resolves the key to a
single internal brand id and writes to that brand's list. The `name` field in
the body is the PERSON's name, not the brand's.

This matters because it means the usual way a multi-brand sync goes wrong
cannot happen here. You do not match on a brand name, so it does not matter
that the brand is called something different in the system you are working in:
"Sanabreh", "Sanabreh Mediterranean" and "SANABREH_HOU" all post to the same
list if they use the same key. Renaming a brand on either side breaks nothing.
There is no string to keep in sync.

The flip side: a wrong key is silent. Leads will go to a real list, just the
wrong one, and no error will tell you. So:

**If the integration handles more than one brand**, keep a map in your own
config from your own brand identifier to the matching key, and fail loudly on
a miss. Never fall back to a default key, because that silently sends a
client's leads to another client's list.

```js
// your config, your naming, one key per brand
const SCALESOLO_KEYS = {
  sanabreh: process.env.SCALESOLO_KEY_SANABREH,
  fairouz:  process.env.SCALESOLO_KEY_FAIROUZ,
}

function keyFor(brand) {
  const k = SCALESOLO_KEYS[brand]
  // Loud, not a default. A missing key means a dropped lead, which is
  // recoverable. A default key means a lead on the wrong client's list,
  // which is not.
  if (!k) throw new Error(`No ScaleSolo key configured for brand "${brand}"`)
  return k
}
```

**To confirm a key really belongs to the brand you think**, open ScaleSolo,
switch the brand selector to that brand, and look at the Sender tab. It lists
only that brand's keys, by name and by the first characters of the key
(`ssk_live_a1b2c3...`). Match those characters against the key you hold. Then
send one test lead and check it lands on that brand's Subscribers tab. Do this
once per key when you wire it up, because it is the only check that catches a
key pasted into the wrong environment variable.

## Rules you must follow

**Call it from a server, never from a browser or a mobile app.** The key can
write to a client's mailing list, so it is a secret. There is deliberately no
CORS header on the endpoint, so browser calls fail by design. If the lead is
captured by a form in a web page, the page posts to your own backend, and your
backend calls ScaleSolo.

**Read the key from an environment variable.** Do not put it in source, in a
config file that gets committed, in a build artifact, or in a client-side
bundle. Do not paste it into a commit message, a PR, or a ticket.

**Never retry a 4xx.** The request was wrong, or the key was, and sending it
again will not change that. Retry only `429` and `5xx`, with backoff.

**Do not write to the database directly.** If anyone suggests connecting to
Supabase or inserting into a contacts table, that bypasses the suppression
rules and can get every brand's email throttled at once. Use this endpoint.

## Tags are the important part

A tag is what starts an email sequence. ScaleSolo automations trigger on a
tag, so a lead sent with `"tags": ["newsletter"]` is enrolled in whichever
sequence is listening for `newsletter`, usually within a minute. A lead sent
with no tag just sits on the list until someone sends a broadcast.

So: ask Ray which tag this source should send, and send exactly that string.
It has to match the automation's trigger tag character for character.

Tag rules, applied server side so you do not need to pre-sanitise, though it
helps to know them:

- lowercased automatically
- 40 characters maximum each
- 20 tags maximum per contact, and the contact's existing tags win if the
  limit is hit, so do not send a long list of junk tags
- a useful convention is `source:thing`, for example `shopify:first-order`
  or `calendly:booked-call`

Use `source` for free-text attribution ("website-footer", "black-friday-ad").
It is recorded on the contact but does not trigger anything.

## Responses, and which ones are not failures

| Status | Body | What it means |
|---|---|---|
| 200 | `{"ok":true,"created":true}` | New contact added. |
| 200 | `{"ok":true,"created":false}` | Already on the list. Tags and any blank name or phone were merged. |
| 200 | `{"ok":true,"skipped":"suppressed"}` | Address bounced or reported spam before. Deliberately not added. |
| 200 | `{"ok":true,"skipped":"unsubscribed"}` | That person opted out. Tags still updated, but they stay unsubscribed. |
| 200 | `{"ok":true,"skipped":"unchanged"}` | Already on the list with these exact details. |
| 400 | `{"code":"bad_email"}` | The address is not a valid address. |
| 401 | `{"code":"no_key"}` | No key sent. |
| 401 | `{"code":"bad_key"}` | Key is unknown, malformed or revoked. |
| 429 | `{"code":"rate_limited"}` | Over 600 requests in an hour on this key. |
| 503 | `{"code":"migration_pending"}` | Should not happen now. Tell Ray if it does. |

**Treat every `200` as success, including the `skipped` ones.** Do not surface
a `skipped` reason to the person filling in the form, and do not retry it.
Those are ScaleSolo protecting the sending reputation, not an error you caused.
Log them if you want visibility.

## Reference implementation

Node, as a backend route that a form posts to:

```js
// POST /api/lead  (your backend, not the browser)
export default async function handler(req, res) {
  const { email, name, phone } = req.body || {}
  if (!email) return res.status(400).json({ error: 'Email required' })

  const r = await fetch('https://www.scalesolo.ai/api/email/subscribe', {
    method: 'POST',
    headers: {
      'x-api-key': process.env.SCALESOLO_INGEST_KEY,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      email,
      name,
      phone,
      tags: ['newsletter'],          // ask Ray for the tag this source should send
      source: 'website-footer',
    }),
  })

  const data = await r.json().catch(() => ({}))

  // A bad key or a misconfigured integration must be loud in YOUR logs, but
  // the visitor should still see a normal thank you: they did nothing wrong
  // and cannot fix it.
  if (!r.ok) console.error('[lead] scalesolo rejected:', r.status, data)
  else if (data.skipped) console.log('[lead] skipped:', data.skipped)

  return res.status(200).json({ ok: true })
}
```

PHP, for a WordPress or plain-PHP site:

```php
$res = wp_remote_post('https://www.scalesolo.ai/api/email/subscribe', [
  'headers' => [
    'x-api-key'    => getenv('SCALESOLO_INGEST_KEY'),
    'content-type' => 'application/json',
  ],
  'body' => wp_json_encode([
    'email'  => $email,
    'name'   => $name,
    'tags'   => ['newsletter'],
    'source' => 'contact-form',
  ]),
  'timeout' => 10,
]);
```

Zapier or Make: a Webhooks "POST" action, URL above, header `x-api-key`, body
as JSON with the fields above. Map the tag as a literal string, not a field
from the trigger, so a blank field cannot silently stop the sequence.

## Before you call it done

1. Send one real lead with a test address you control, then ask Ray to confirm
   it appears in ScaleSolo under Email, Subscribers, with the tag on it.
2. Submit the same address twice. The second should come back
   `created: false` and must not produce an error or a duplicate.
3. Submit a deliberately bad address. Your form should handle the `400`
   without showing the visitor a stack trace.
4. Confirm the key is not in the repository: `git grep ssk_live_` must find
   nothing, and the key must not appear in any built or client-side file.

5. If the integration covers more than one brand, send a test lead through
   EVERY brand path, not just the first. A key in the wrong environment
   variable is invisible until someone notices leads on the wrong list.

## Things to ask Ray rather than guess

- Which brand's key to use, if more than one brand is involved. Ask for the
  key's visible prefix alongside it so you can confirm the pairing.
- Which tag each capture point should send, since that is what decides which
  email sequence the person gets.
- Whether a phone number should be collected at all, since it is optional and
  changes what the form has to ask for.
