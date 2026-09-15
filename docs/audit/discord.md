# discord

`@msgly/discord` — Interactions API (Ed25519-signed webhooks, not the gateway).
Reviewed: `send`, `handleWebhook`, `getInteractionAck`, `verifySignature`.

## Medium

### Discord's error codes defeat the hub's retry check

`code: discord_${data.code ?? res.status}`
([index.ts:283](../../packages/adapter-discord/src/index.ts:283)) — `data.code` is
Discord's JSON error code (`10003` unknown channel, `50001` missing access,
`50007` cannot send to this user), so nothing matches an HTTP status and every
failure is retried three times. Discord's 401 body carries `code: 0`, so a dead
bot token becomes `discord_0` and is retried too.

### `50007` never suppresses

"Cannot send messages to this user" — DMs closed or the bot blocked — is
recipient-fatal and carries no `permanent` flag.

### `retry_after` is ignored

Discord returns it in the 429 body, in seconds, and distinguishes per-route from
global limits. Neither is read.

### An expired interaction token fails opaquely

`send()` PATCHes `/webhooks/{app}/{token}/messages/@original` when
`metadata.interactionToken` is present. That token is valid for 15 minutes; past
it Discord returns an error that is retried three times and surfaced as a plain
`discord_*` code. Worth naming explicitly, since the deferred-ack pattern makes
it easy to reply late.

## Low

### Inbound identity mixes a channel with a person

`contact.channelUserId` is `interaction.channel_id` while `displayName` is the
invoking user's username. Replying to the channel is right; labelling that id
with a person's name is not, and the actual user id is only in `metadata.userId`.

### Media filenames are not carried

`MediaReference.filename` is unread on the way out.

## Sound

Ed25519 verification is correct and fails closed — no secret-missing bypass,
signature length checked, errors swallowed into `false`. Deferred acks are
returned for both command and component interactions, which is what keeps the
3-second deadline. `message_reference` uses `fail_if_not_exists: false`, so a
deleted parent degrades instead of failing the send. `externalId` is set from
`interaction.id`.
