# twilio-voice

`@msgly/twilio-voice` — Programmable Voice. Largely rewritten in v1.7.0; that
changeset covers the response model, the capability mismatch, the missing
`<Gather>` mapping and the fail-open signature check. What follows is what this
pass found on top of it.

## Medium

### Send and status receipts use two different code namespaces

`send()` fails with `twilio_voice_unsupported_content` and friends
([index.ts:452](../../packages/adapter-twilio-voice/src/index.ts:452)), while
`parseStatuses` emits Twilio's raw `ErrorCode` — or the bare call status —
with no prefix ([index.ts:656](../../packages/adapter-twilio-voice/src/index.ts:656)).
So `13224` and `busy` land in the same field as `twilio_voice_*`, and a caller
matching on `code` has to know which path produced the receipt. This is the same
split `@msgly/whatsapp` closed in this release; the fix is the same prefix.

### Local validation failures are retried

`twilio_voice_unsupported_content`, `twilio_voice_unplayable_media` and the
missing-`callSid` receipt are all decided before any network call, and each costs
three passes through the hub's backoff.

## Low

### `Retry-After` is ignored

Consistent with the rest of the library.

## Sound

`parseStatuses` is the best status mapping in the library and the model the SMS
adapters should copy: the full call-progress vocabulary is mapped, `recipientId`
comes from `To`, and the permanence rule is right and explained — busy and
no-answer are transient because the person may answer next time, only a failed
call is a bad number. `respond()` produces TwiML inside the webhook request with
no shared state, which is the only correct shape for a channel where the HTTP
response *is* the reply. Unsigned webhooks are refused unless
`allowUnsignedWebhooks` is set explicitly.
