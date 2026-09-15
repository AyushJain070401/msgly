# resend

`@msgly/resend` — Resend API with Svix-signed webhooks. Reviewed: `send`,
`handleWebhook`, `verifySignature`, attachment handling.

## Medium

### Resend's error names defeat the hub's retry check

`resend_${data.name ?? res.status}` — `name` is a string (`validation_error`,
`missing_api_key`), so nothing matches an HTTP status and every failure is
retried three times, including a missing API key.

### A rejected recipient never suppresses on send

`permanent` is set on the *webhook* path from `email.bounced`/`email.complained`,
which is correct — but a synchronous 4xx naming an invalid address sets nothing,
so the address is only suppressed if the asynchronous event arrives.

### Verification falls open without a webhook secret

`if (!config.webhookSecret) return true`. Svix signs everything Resend sends, so
this only matters for an unconfigured deployment — which is precisely the one
that will be receiving forged bounce events.

## Low

### `resend_unsupported_content` is retried

Decided before any network call.

## Sound

Svix verification is complete: id, timestamp and signature all required, a
replay window enforced against the timestamp, constant-time comparison. The
comment on the bounce mapping is right — only `email.bounced` and
`email.complained` set `permanent`, because marking a `delivery_delayed` as
permanent would suppress recipients who are perfectly fine. Attachments carry
real filenames both ways, and inbound attachment refs encode the email id and
filename so they can be fetched later. `recipientId` is set on webhook receipts.
