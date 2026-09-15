# reddit

`@msgly/reddit` — OAuth API, polled. `handleWebhook` runs `poll()` rather than
parsing a payload. Reviewed: `send`, `poll`, `verifySignature`,
error classification.

## High

### The poll endpoint is open to anyone

`verifySignature` returns `true` unconditionally and `handleWebhook` triggers a
poll ([index.ts](../../packages/adapter-reddit/src/index.ts)). Reddit's free OAuth
tier is about 100 queries per minute and it enforces hard — the library's own
rate-limit table sets this channel at 1/second for that reason. Anyone who finds
the endpoint can drive your quota into the ground from unauthenticated requests,
and the consequence lands on your app's Reddit credentials.

There is no signature to verify, which is why this needs an explicitly
configured shared secret rather than a default of open.

### A wrong content type suppresses the contact

`reddit_unsupported_content` and `reddit_missing_thing_id` both carry
`permanent: true` ([index.ts:296](../../packages/adapter-reddit/src/index.ts:296)).
Those are local validation failures — the caller passed an image, or forgot
`metadata.thingId`. A suppression store reads `permanent: true` as "this
recipient is dead" and bins them.

## Medium

### `permanent: error.code !== 'RATELIMIT'` is too broad

Everything that is not a rate limit is marked recipient-fatal, including
`USER_REQUIRED` and other auth failures, which say nothing about the thread.

### Reddit's error codes defeat the hub's retry check

`reddit_${error.code}` — Reddit's string codes (`RATELIMIT`, `THREAD_LOCKED`),
so nothing matches an HTTP status. `RATELIMIT` in particular is retried three
times in quick succession against an API that punishes exactly that.

## Low

### `Retry-After` is ignored

Reddit sends it, and `RATELIMIT` responses often name a wait in the message text
as well.

## Sound

The refusal to send unsolicited DMs is the right call and the error says why —
that it is spam under Reddit's content policy and gets accounts banned — while
pointing at `publishPost()` as the legitimate route. `thingTypeOf` validates the
fullname prefix (`t1_`/`t3_`/`t4_`) before the call rather than after. The
comment distinguishing a rate limit from a deleted thread shows the right model,
applied to too coarse a rule.
