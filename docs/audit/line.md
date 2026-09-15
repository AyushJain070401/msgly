# line

`@msgly/line` — Messaging API. Reviewed: `send`, `broadcast`, `multicast`,
`handleWebhook`, `verifySignature`, capabilities.

## High

### Any 4xx suppresses the recipient

`permanent: res.status >= 400 && res.status < 500 && res.status !== 429`
([index.ts:459](../../packages/adapter-line/src/index.ts:459)). That is every
client error, not every dead recipient. A `401` from a rotated channel access
token, or a `400` from a malformed message object, marks whoever you were
messaging as permanently dead, and a suppression store will drop them from all
future sends. Token rotation is routine on LINE; the blast radius is everyone
you message during the window.

## Medium

### Postbacks cannot be deduplicated

The postback branch of `handleWebhook`
([index.ts:270](../../packages/adapter-line/src/index.ts:270)) sets no
`externalId`, so the hub cannot drop a repeat. LINE re-delivers when your
endpoint is slow, and it hands you two signals the adapter never reads:
`webhookEventId` and `deliveryContext.isRedelivery`.

### `account.channelAccountId` is the user on postbacks

`event.source.userId ?? 'self'` — the *sender*, in the account slot. The webhook
body carries `destination`, which is the bot. The message branch and the
postback branch disagree.

### Delivery events are dropped

`send()` returns `sent` when the API accepts the message; LINE's actual delivery
state and the `unsend`/`unfollow` events are not surfaced. `unfollow` in
particular is the real recipient-fatal signal on this channel, and it is the one
that should drive suppression instead of the 4xx rule above.

## Low

### `replyTo` is ignored

LINE's reply token is stashed in `metadata.replyToken` and used to pick the
reply endpoint — a different mechanism from threading, and the one LINE actually
has. `message.replyTo` is never read, which is defensible, but it means setting
the documented cross-channel field here does nothing at all.

### `line_multicast_limit` is marked permanent

A local validation failure — the caller passed more than 500 user ids — flagged
with the field that suppresses recipients. Nothing good comes of that reaching a
suppression store.

## Sound

Constant-time HMAC-SHA256 verification with no missing-secret bypass. Inbound
file messages capture `fileName` into `mediaRef.filename`, and `downloadMedia`
carries it back out — one of the few adapters that round-trips a filename.
`file: false` in capabilities is a real platform limit and is documented as such
rather than left looking like a gap. Error codes carry the HTTP status, so the
hub's retry check works. `getQuotaRemaining` is exposed.
