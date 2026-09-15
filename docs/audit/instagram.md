# instagram

`@msgly/instagram` — Instagram Messaging API. Shares `meta-base.ts` with `@msgly/messenger`
(two near-identical copies, 412 and 369 lines). Reviewed: `send`,
`handleWebhook`, `verifySignature`, capabilities.

## Medium

### The page access token travels in the URL

`${sendUrl()}?access_token=${encodeURIComponent(config.pageAccessToken)}`
([meta-base.ts](../../packages/adapter-instagram/src/meta-base.ts)). Query strings
are logged by proxies, CDNs and most HTTP middleware, and a page token is a
long-lived credential. The Graph API accepts `Authorization: Bearer`, which is
what `@msgly/whatsapp` uses against the same API.

### Meta's error codes defeat the hub's retry check

`code: meta_${data.error?.code ?? res.status}` — the application code, so
`190` (expired token), `551` (user unavailable) and `10` (outside the 24-hour
window) are all retried three times. None carries `permanent` or `retryable`,
so `551` never suppresses either.

### Postbacks cannot be deduplicated

The postback branch sets no `externalId`; Meta re-delivers when your endpoint
does not 200 quickly.

### `messaging_type` is hardcoded to `RESPONSE`

Instagram's window is 24 hours with a `HUMAN_AGENT` extension to 7 days for a
person replying by hand — the tag that extension needs cannot be passed, so
those sends simply fail.

### `replyTo` is ignored

Instagram supports `reply_to.mid`. Core documents `replyTo` as safe to set
anywhere; here it silently does nothing.

## Low

### Errors are namespaced `meta_`, not `messenger_`

Both Meta channels emit the same prefix from the shared base, so a receipt
cannot say which channel produced it.

### The shared base can send more than the capabilities admit

`meta-base.ts` handles `audio` and `file`, while Instagram's `CAPABILITIES`
declare both `false` ([index.ts](../../packages/adapter-instagram/src/index.ts)),
so the hub refuses them before `send()` is reached. If that reflects a real
Instagram limit it is correct and worth a comment saying so, as `@msgly/line`
does for its own `file: false`; if not, it is capability the adapter already has
and does not offer.

## Sound

`is_echo` filtering prevents the reply loop
([meta-base.ts:197](../../packages/adapter-instagram/src/meta-base.ts:197)).
Signature verification is constant-time HMAC-SHA256 over the raw body with a
`sha256=` prefix check and no missing-secret bypass. Quick-reply payloads are
surfaced as `interaction.data`, and message inbound sets `externalId` from `mid`.
