# wechat

`@msgly/wechat` — Official Account API. Reviewed: `send`, `callCustomerApi`,
`callMassApi`, `handleWebhook`, `verifySignature`.

## High

### Token expiry suppresses the whole audience

`permanent: data.errcode !== 45028 && data.errcode !== 45009`
([index.ts:611](../../packages/adapter-wechat/src/index.ts:611)) — everything
except two quota codes is treated as permanent, which a suppression store reads
as "this recipient is dead". WeChat access tokens expire every 7200 seconds by
design, and a send during the refresh window returns `40001`. So does `-1`,
which WeChat documents as "system is busy, please try again later". Both bin
recipients who are perfectly reachable.

### The 48-hour window looks like a dead user

`45015` ("response out of time limit") means the customer-service window has
closed — the same class of failure as WhatsApp's `131047`, and equally not a
dead recipient. Under the rule above it is permanent.

## Medium

### `send()` collapses every failure into one code

`callCustomerApi` throws a string and `send` catches it into
`code: 'wechat_send_failed'`
([index.ts](../../packages/adapter-wechat/src/index.ts)), with the errcode left
inside the message text. The single most actionable field WeChat returns is
unreachable to a caller, and the failure carries neither `permanent` nor
`retryable` — so `40001` is retried three times and then reported as an
unstructured string.

### Nothing distinguishes a token problem from a message problem

A shared `getAccessToken()` failure and a rejected message arrive identically.
Since tokens expire on a timer, this is the failure operators will see most.

### Inbound events are dropped

`handleWebhook` handles message types; `unsubscribe` — the event that actually
means "stop messaging this person" — is not surfaced.

## Low

### Media filenames are not carried

Neither direction reads or sets `mediaRef.filename`.

## Sound

Signature verification is correct, with a timestamp skew bound. XML parsing is
defensive about missing fields. Media sends correctly insist on a `platform-id`
(WeChat has no URL-fetch path) and say so in the error. Mass-send quota
exhaustion (`45028`) and media-id failures (`45009`) are correctly singled out as
transient, which is the right instinct applied to too small a set.
