# twilio-sms

`@msgly/twilio-sms` — Programmable Messaging. Reviewed: `send`, `handleWebhook`,
`verifySignature`, capabilities.

## High

### A STOP reply never suppresses the number

Twilio returns `21610` when the recipient has replied STOP and the number is on
your opt-out list. The adapter records it as an ordinary failure with no
`permanent` flag ([index.ts:282](../../packages/adapter-twilio-sms/src/index.ts:282)),
so nothing suppresses them and every future campaign tries again. Twilio blocks
the message, so no SMS is delivered — but the intent recorded in your own system
is that you keep messaging someone who opted out, which is the part that matters
if anyone ever asks.

`21211` (invalid `To`) and `21614` (not a mobile number) are equally dead and
equally unflagged.

### Delivery receipts are configured and then discarded

`config.statusCallbackUrl` sets `StatusCallback` on every send, so Twilio posts
delivery updates to your endpoint — and nothing parses them. `handleWebhook`
only builds inbound messages; there is no `parseStatuses` as
`@msgly/twilio-voice` and `@msgly/whatsapp` both have. For SMS this is where
real failure appears: the API accepts almost everything and the carrier rejects
later (`30003` unreachable, `30005` unknown destination, `30007` filtered).

## Medium

### Twilio's error codes defeat the hub's retry check

`twilio_${data.error_code ?? res.status}` — `21211` and friends match no HTTP
status, so an invalid number is retried three times.

### An uploaded media ref silently sends as a plain SMS

```ts
if (message.content.caption) formData.set('Body', message.content.caption);
if (message.content.mediaRef.kind === 'url') formData.set('MediaUrl', ...);
```
A `platform-id` ref sets no `MediaUrl`. With a caption present the message goes
out as text with the image quietly missing; the caller is told it was sent.

### Only the first inbound media part is read

`MediaUrl0` only. An MMS with `NumMedia: 3` yields one image and drops the rest.
The content type is also hardcoded to `image` regardless of
`MediaContentType0`, so an inbound video or PDF is mislabelled.

## Low

### Local validation failures are retried

`twilio_sms_unsupported_content` is decided before any network call.

## Sound

Signature verification implements Twilio's scheme properly — HMAC-SHA1 over the
URL plus sorted POST parameters, constant-time comparison — and only falls open
when `webhookUrl` is unset. `verifyCredentials` checks the `AC` prefix on the
account SID and gives specific hints per failure. `queued` is mapped distinctly
from `sent`, which is honest about what Twilio actually confirmed.
