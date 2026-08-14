---
'@msgly/telnyx': minor
'@msgly/sendgrid': minor
'@msgly/core': minor
---

Add `@msgly/telnyx` and `@msgly/sendgrid`.

**Telnyx** — global SMS/MMS verified with Ed25519 over `"{timestamp}|{body}"`,
plus a timestamp window bounding replay. Verification fails closed when the
runtime's Web Crypto lacks Ed25519, rather than silently accepting unverified
webhooks.

**SendGrid** — transactional email over HTTP, Edge-compatible. Handles the two
differently-secured webhooks explicitly: the unsigned Inbound Parse endpoint is
guarded by a URL token and produces messages, while the ECDSA-signed Event
Webhook produces receipts via `parseDeliveryEvents`. The ECDSA signature is
DER-encoded and is converted to the P1363 form Web Crypto requires — passing DER
straight through fails every time. Reads the message id from the `X-Message-Id`
header, since `/v3/mail/send` returns 202 with an empty body, and
`verifyCredentials` confirms the key actually carries the `mail.send` scope.
