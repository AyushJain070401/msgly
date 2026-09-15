# fcm

`@msgly/fcm` — Firebase Cloud Messaging HTTP v1. Push only: `handleWebhook`
returns `[]` and there is no inbound path. Reviewed: `send`, `sendToTopic`,
error classification, auth.

## Medium

### `INVALID_ARGUMENT` suppresses the device over a payload bug

```ts
const PERMANENT_FCM_ERRORS = new Set([
  'UNREGISTERED', 'INVALID_ARGUMENT', 'SENDER_ID_MISMATCH',
]);
```
([index.ts:131](../../packages/adapter-fcm/src/index.ts:131)) — `UNREGISTERED` and
`SENDER_ID_MISMATCH` are genuinely about the token. `INVALID_ARGUMENT` is not:
FCM returns it for a malformed *message* as readily as a malformed token — an
oversized data payload, a bad notification field, an invalid TTL. Marking it
permanent means one bad payload suppresses every device it was sent to, and they
are all still perfectly reachable.

The adapter already prefers `details[].errorCode` over the generic `status`, with
a comment saying why; the fix is to only treat `INVALID_ARGUMENT` as permanent
when it arrived as a specific `errorCode`, not as the fallback `status`.

### Transient errors are not marked

`UNAVAILABLE`, `INTERNAL` and `QUOTA_EXCEEDED` are exactly the cases where a
retry helps, and FCM documents an exponential-backoff expectation with a
`Retry-After` on `UNAVAILABLE`. Neither `retryable: true` nor the header is used,
so the hub retries on its own short schedule and gives up after three.

## Low

### Local validation failures are retried

`fcm_missing_token`, `fcm_media_url_required` and `fcm_unsupported_content` are
all decided before any network call.

## Sound

The only adapter besides `@msgly/whatsapp` that classifies its errors at all, and
the comment explaining why `details[].errorCode` beats `status` shows the right
instinct — `status` is the generic gRPC name and genuinely cannot distinguish a
dead token from a bad request. Service-account JWT exchange is cached. The
media error explains the platform's actual model (the device fetches the image,
so an uploaded id is meaningless) rather than just refusing.
