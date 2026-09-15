# tiktok

`@msgly/tiktok` — Content Posting, comments and DMs. Reviewed: `send`,
`publishVideo`, `handleWebhook`, `verifySignature`, error classification.

## High

### Local validation failures suppress the contact

`tiktok_unsupported_content`, `tiktok_unknown_kind`,
`tiktok_missing_comment_target` and `tiktok_missing_conversation` all carry
`permanent: true`
([index.ts:679](../../packages/adapter-tiktok/src/index.ts:679) onwards). Every one
of them is decided locally, before any network call — the caller passed the
wrong content type or forgot a metadata key. `permanent: true` tells a
suppression store the recipient is dead, so a programming mistake removes a real
person from the audience.

## Medium

### `permanent: !isTransient(code)` inherits the same problem

An auth failure or a bad app configuration is "not transient", so it is marked
recipient-fatal and suppresses.

### TikTok's error codes defeat the hub's retry check

`tiktok_${code}` — TikTok's own string codes, so nothing matches an HTTP status
and every failure is retried three times.

### Local validation failures are retried as well as suppressed

The same four receipts above cost three passes through the hub's backoff before
surfacing.

## Low

### `Retry-After` is ignored

The Content Posting API is quota'd per app per day and posting is asynchronous,
so bursting buys nothing — as the library's own rate-limit comment notes.

## Sound

The `kind` guard is genuinely careful: falling through to a DM when
`metadata.kind` is unrecognised would message whoever `contact.channelUserId`
happens to name, and the code says so. `recipientId` is set on both success
paths, which almost nothing else in the library does. The network-error branch
is explicitly excluded from `permanent` with a comment explaining that a dropped
connection is not a dead recipient — the right distinction, made in one place
and missed in four others in the same file.
