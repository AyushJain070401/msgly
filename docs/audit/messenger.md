# messenger

`@msgly/messenger` — Meta Send API. Shares `meta-base.ts` with `@msgly/instagram`
(two near-identical copies, 412 and 369 lines). Reviewed: `send`,
`handleWebhook`, `verifySignature`, capabilities.

## Medium

### The page access token travels in the URL

`${sendUrl()}?access_token=${encodeURIComponent(config.pageAccessToken)}`
([meta-base.ts](../../packages/adapter-messenger/src/meta-base.ts)). Query strings
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

Outside the 24-hour window a send needs `MESSAGE_TAG` with a tag, or `UPDATE`.
There is no way to pass either, so those sends simply fail.

### `replyTo` is ignored

Messenger supports `reply_to.mid`. Core documents `replyTo` as safe to set
anywhere; here it silently does nothing.

## Low

### Errors are namespaced `meta_`, not `messenger_`

Both Meta channels emit the same prefix from the shared base, so a receipt
cannot say which channel produced it.

### Media filenames are not carried

`MediaReference.filename` is unread.

## Sound

`is_echo` filtering prevents the reply loop
([meta-base.ts:217](../../packages/adapter-messenger/src/meta-base.ts:217)).
Signature verification is constant-time HMAC-SHA256 over the raw body with a
`sha256=` prefix check and no missing-secret bypass. Quick-reply payloads are
surfaced as `interaction.data`, and message inbound sets `externalId` from `mid`.
