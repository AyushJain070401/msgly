# vonage-sms

`@msgly/vonage-sms` — SMS API. Reviewed: `send`, `handleWebhook`,
`verifySignature`, status mapping.

## High

### A multipart SMS is reported on its first part only

```ts
const first = data.messages?.[0];
if (first && mapVonageStatus(first.status) === 'sent') { ... }
```
([index.ts](../../packages/adapter-vonage-sms/src/index.ts)) — Vonage splits a
long message and returns one object per part. If part 1 is accepted and part 3
is rejected for insufficient funds or an invalid number, the receipt says `sent`
and the recipient gets a truncated message. Nothing in the receipt hints that
three parts were involved.

## Medium

### Delivery receipts are dropped

`if (params['status'] && !text) return []` — DLRs arrive on the same endpoint and
are discarded. Vonage's `status` field is where a failed delivery is reported;
without it, a send that Vonage accepted and the carrier rejected is invisible.

### Vonage's status codes are unclassified

`vonage_${code}` where code is `1` (throttled), `4`/`5` (internal error), `6`
(invalid message), `9` (partner quota), `11` (unroutable), `15` (illegal
sender). Throttles are retryable and unroutable numbers are recipient-fatal;
neither is marked, and none matches an HTTP status, so all are retried three
times.

### Inbound multipart messages are not reassembled

Vonage sends `concat`, `concat-ref`, `concat-total` and `concat-part` for a long
inbound SMS. The adapter surfaces each part as its own message, so a handler
sees fragments.

## Low

### Local validation failures are retried

`vonage_unsupported_content` is decided before any network call.

## Sound

The GSM-7 check is the detail most SMS integrations get wrong and this one gets
right: non-GSM-7 text is sent as `unicode`, with a comment explaining that
sending it as `text` silently mangles the message. The 200-with-failure shape is
handled — the adapter checks the per-message status rather than the HTTP status,
with a comment saying why. Signature verification is constant-time over sorted
parameters. `verifyCredentials` reports the account balance.
