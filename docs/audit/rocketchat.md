# rocketchat

`@msgly/rocketchat` — self-hosted. Reviewed: `send`, `handleWebhook`,
`verifySignature`, capabilities.

## Medium

### Rocket.Chat's `errorType` defeats the hub's retry check

`rocketchat_${data.errorType ?? res.status}` — `errorType` is a string
(`error-invalid-room`, `error-not-allowed`), so nothing matches an HTTP status
and every failure is retried three times.

### `error-invalid-room` never suppresses

A deleted room is recipient-fatal here — the room *is* the contact — and carries
no `permanent` flag.

### `replyTo` is ignored

Rocket.Chat threads on `tmid`. Only `metadata.roomId` is read, for addressing;
nothing sets a thread parent.

## Low

### Media is linked, never uploaded

`chat.postMessage` attachments take a URL, so a `platform-id` ref is rejected
with `rocketchat_media_url_required`. The error names `rooms.upload` as the
alternative but the adapter does not implement it, so the suggestion is not
actionable from inside the library.

## Sound

The bot's own integration posts are filtered by the `bot` field, with a comment
explaining the loop it prevents. Empty or whitespace-only text is dropped rather
than forwarded as an empty message. `mediaRef.filename` is used for the file
attachment title. Room, user and message ids all reach `metadata`, and
`externalId` is set from `message_id`. The token comparison is constant-time.
