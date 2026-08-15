---
'@msgly/plivo': minor
'@msgly/resend': minor
'@msgly/core': minor
---

Add `@msgly/plivo` and `@msgly/resend`.

**Plivo** — global SMS and MMS with V3 webhook signature verification
(`base64(HMAC-SHA256(authToken, url + nonce))`), accepting multiple
comma-separated signatures so key rotation doesn't cause an outage. Because
Plivo signs the URL, `webhookUrl` must match exactly, and the README says so.
MMS with a non-URL media reference fails fast rather than being rejected by the
API, since Plivo has no upload endpoint.

**Resend** — transactional email over HTTP, so unlike `@msgly/smtp` it is
Edge-compatible. Verifies Svix-signed webhooks including a timestamp window that
bounds replay. Delivery events (`email.sent`/`delivered`/`bounced`/…) are
deliberately kept out of `handleWebhook` and exposed via `parseDeliveryEvent`
instead, so status updates don't pollute the inbound message handler.
`verifyCredentials` checks that the sending domain is registered *and verified*,
which is the usual cause of a confusing first-send 422.
