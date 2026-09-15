# smtp

`@msgly/smtp` — Nodemailer transport with IMAP polling. Reviewed: `send`,
`handleWebhook`/`poll`, `verifySignature`.

## High

### SMTP tells you exactly which failures are permanent, and nothing listens

```ts
code: `smtp_${raw.responseCode ?? raw.code ?? 'error'}`
```
([index.ts:526](../../packages/adapter-smtp/src/index.ts:526)) — a 5xx response is
a permanent failure by definition of the protocol, and a 4xx is explicitly
temporary. That is the cleanest permanent/transient signal any channel in this
library provides, and neither `permanent` nor `retryable` is set from it. So a
`550 user unknown` is retried three times and the address stays in the audience
forever, while a `451 try again later` gets no special treatment either.

`smtp_rejected` — built from Nodemailer's `info.rejected`, which is a
per-recipient hard rejection — is unflagged for the same reason.

## Medium

### The poll endpoint is open

`verifySignature` returns `true` unconditionally and `handleWebhook` runs
`poll()`. Anyone who finds the URL can drive your IMAP connection at whatever
rate they like. There is no signature to verify here, which is exactly why this
should require an explicitly configured shared secret rather than defaulting to
open — the same change `@msgly/twilio-voice` made in v1.7.0.

### `replyTo` is ignored

The adapter threads on `metadata.messageId` into `In-Reply-To`/`References`, but
does not read `message.replyTo`, which carries the same thing under the
documented cross-channel name.

### Bounces are invisible

A bounce arrives as an inbound email from `postmaster@`. Nothing parses DSN
(RFC 3464) reports, so the most important delivery signal on this channel is
delivered to the caller as an ordinary message.

## Low

### `smtp_unsupported_content` is retried

Decided before the transport is touched.

## Sound

Header values are sanitised against injection. `Re:` prefixing is handled
sensibly, and `References` is assembled from the existing chain plus the parent
rather than overwritten. Attachments are built with real filenames and content
types. The poll loop tracks its position rather than re-reading the mailbox.
