# telnyx

`@msgly/telnyx` — Messaging API. Reviewed: `send`, `handleWebhook`,
`verifySignature`.

## Medium

### Delivery receipts are dropped

`if (data?.event_type !== 'message.received' || !data.payload) return []`
([index.ts](../../packages/adapter-telnyx/src/index.ts)) — `message.sent` and
`message.finalized` are the events that carry the final delivery state and the
carrier's error, and they are discarded with a comment noting they are receipts.
Nothing turns them into `DeliveryReceipt`s.

### Telnyx error codes defeat the hub's retry check

`telnyx_${first?.code ?? res.status}` — Telnyx's own numeric codes (`40300`
etc.), so nothing matches an HTTP status and every failure is retried three
times. None is classified, so an invalid destination never suppresses.

### Only the first inbound media part is read

`payload.media?.[0]`, and the content type is hardcoded to `image` regardless of
`content_type`, so an inbound video or PDF is mislabelled and any second
attachment is dropped.

## Low

### Local validation failures are retried

`telnyx_unsupported_content` and `telnyx_media_url_required` are both decided
before any network call.

## Sound

Ed25519 signature verification with a timestamp tolerance, which is the correct
scheme for Telnyx — and it fails closed on a missing or malformed header, only
falling open when no `publicKey` is configured at all. `occurred_at` is used for
the inbound timestamp rather than arrival time. `externalId` is set from the
payload id.
