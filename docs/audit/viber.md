# viber

`@msgly/viber` — Public Account API. Reviewed: `send`, `broadcast`,
`handleWebhook`, `buildOutbound`, `verifySignature`.

## Medium

### File and video sends report a size of zero

```ts
{ type: 'file', media: ..., size: 0, file_name: ... }
{ type: 'video', media: ..., size: 0 }
```
([index.ts](../../packages/adapter-viber/src/index.ts)) — Viber's API takes the
file size in bytes and uses it client-side. Zero is not a valid size; at best the
client shows nothing useful, at worst the send is rejected. The adapter cannot
know the size of a URL it did not fetch, so this needs either a HEAD request or
a `size` on the media reference.

### `unsubscribed` is dropped

`if (event.event !== 'message') return []` — which throws away `unsubscribed`,
the event that means the user removed the bot. That is the recipient-fatal
signal on this channel and nothing surfaces it. `failed` and `delivered` go the
same way.

### Viber's status codes defeat the hub's retry check

`viber_${data.status ?? 'unknown'}` — Viber's own numeric status, so nothing
matches an HTTP status and every failure is retried three times.

### Local validation failures are marked permanent

`viber_broadcast_limit` and `viber_unsupported_content` carry `permanent: true`,
which a suppression store reads as "this recipient is dead". Passing too many
receivers to `broadcast` should not suppress anybody.

## Low

### Media refs must be URLs, silently

`buildOutbound` returns `null` for a `platform-id` media ref, which the caller
sees as `viber_media_url_required`. Fine, but `uploadMedia` exists on the
adapter, so the two halves disagree about what a media reference is for.

## Sound

Signature verification is constant-time HMAC over the raw body and fails closed
when the header is missing. `file_name` is taken from `mediaRef.filename` first,
falling back to the caption — the right precedence, and one of the few adapters
that reads the field at all. `tracking_data` round-trips into `metadata`.
`externalId` comes from `message_token`.
