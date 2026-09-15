# gmail

`@msgly/gmail` — Gmail API with Pub/Sub push. Reviewed: `send`, `handleWebhook`,
`verifySignature`, attachment handling, MIME building.

## High

### The history cursor advances before the messages are read

```ts
messageIds = await listMessageIdsSince(lastHistoryId);
lastHistoryId = notification.historyId;
await persistHistoryId(notification.historyId);

for (const id of messageIds) {
  const msg = await fetchMessage(id);   // throws → the rest are lost
```
([index.ts](../../packages/adapter-gmail/src/index.ts)) — the cursor is persisted
before a single message has been successfully fetched. If `fetchMessage` throws
on message 2 of 5 — a timeout, a 429, a transient 5xx — the exception leaves the
loop, but the cursor has already moved past all five. Pub/Sub redelivers the
notification, `listMessageIdsSince` now starts from the *new* cursor, and
messages 2–5 are never seen again.

Persisting after the loop, or per message, closes it.

## Medium

### Pub/Sub ordering is assumed

`lastHistoryId` is overwritten with whatever the latest notification says. Pub/Sub
does not guarantee order, so an older notification arriving late moves the cursor
backwards and replays history (the hub's `externalId` dedup absorbs that) or, in
the other order, skips forward.

### `replyTo` is ignored

Gmail threads on `threadId`, which the adapter reads inbound into
`metadata.threadId` and sends outbound from the same key. `message.replyTo` —
the documented cross-channel field — is not read, so a caller following core's
API gets an unthreaded reply.

### Invalid recipients never suppress

Gmail reports a bad address as a 400 with a message, and bounces arrive later as
a separate email. Neither path sets `permanent`, so email's most important
signal — this address is dead — never reaches a suppression store. `@msgly/ses`
does this properly; Gmail could follow it.

## Low

### `gmail_unsupported_content` is retried

Decided before any network call, retried three times anyway.

## Sound

Error codes work with the hub's retry check by accident of Google's API shape —
`error.code` *is* the HTTP status here. The MIME builder is careful: header
values are sanitised against injection, filenames are RFC 2047 encoded so
non-ASCII survives, `In-Reply-To` and `References` are both set. Attachment size
is checked against a configured limit before the request rather than after.
Push auth supports a verified Google JWT with audience and service-account
pinning — the strongest of the three modes, and `'none'` is an explicit choice
rather than a silent default.
