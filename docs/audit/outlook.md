# outlook

`@msgly/outlook` — Microsoft Graph with change notifications. Reviewed: `send`,
`handleWebhook`, `verifySignature`, attachment handling.

## Medium

### Graph's error codes defeat the hub's retry check

`outlook_${data.error?.code ?? res.status}` — Graph codes are strings
(`ErrorInvalidRecipients`, `InvalidAuthenticationToken`, `ErrorQuotaExceeded`),
so nothing matches an HTTP status and every failure is retried three times,
including an expired token.

### `ErrorInvalidRecipients` never suppresses

Graph names the dead address explicitly and the receipt carries no `permanent`
flag, so it stays in the audience.

### `replyTo` is ignored

The adapter threads through Graph's `/reply` endpoint, keyed on
`metadata.messageId` ([index.ts:887](../../packages/adapter-outlook/src/index.ts:887)).
`message.replyTo` — the documented cross-channel field — is never read, so a
caller following core's API gets a new thread.

### Bounces are not surfaced

A non-delivery report arrives as an ordinary inbound email. Nothing recognises
it, so it reaches the caller as a normal message from `postmaster@` rather than a
delivery failure.

## Low

### `outlook_mime_too_large` is retried

The MIME size is checked locally against Graph's limit, and the resulting receipt
is still retried three times.

## Sound

`clientState` is verified on every notification entry with a constant-time
comparison, and the validation handshake is short-circuited explicitly rather
than accidentally. The MIME path mirrors Gmail's care — header sanitisation,
RFC 2047 filenames, per-attachment size limits — and the adapter chooses between
the JSON API and a raw MIME send depending on whether `unsubscribe` headers are
needed, with the tradeoff documented in the error message. Graph's own `/reply`
endpoint is used for threaded replies, so it adds correct
`In-Reply-To`/`References` headers.
