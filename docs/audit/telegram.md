# telegram

`@msgly/telegram` — Bot API. Reviewed: `send`, `handleWebhook`, `parseContent`,
`verifySignature`, `downloadMedia`.

## High

### A blocked bot is invisible

Telegram's `403 Forbidden: bot was blocked by the user` is the clearest
recipient-fatal signal any channel gives, and the adapter records it as an
ordinary failure ([adapter.ts:390](../../packages/adapter-telegram/src/adapter.ts))
with no `permanent` flag, so nothing suppresses the user. The `my_chat_member`
update, which announces the same thing on the inbound side, is not handled at
all — `handleWebhook` reads `message`, `edited_message` and `callback_query` and
returns `[]` for everything else. So a user who blocks the bot stays in every
future campaign, through both routes.

## Medium

### `retry_after` is ignored

A 429 carries `parameters.retry_after` in seconds. It is never read, so the hub
retries on its own 500ms/1s schedule while Telegram is asking for considerably
longer.

### Unsupported content throws instead of failing

`default: throw new Error('Unsupported content type for Telegram')`. A thrown
error is retried three times by the hub, where the `*_unsupported_content`
receipt other adapters return at least surfaces immediately. It is also
inconsistent with the rest of the library.

### Document filenames are dropped both ways

Telegram sends `document.file_name` inbound and accepts a filename on multipart
uploads; neither appears anywhere in the adapter. `downloadMedia` returns a
`MediaFile` with no `filename` either.

### `channel_post` updates are dropped

Messages posted to a channel the bot administers never surface. Whether that is
in scope is a decision, but right now it is silent.

## Low

### The webhook secret is compared with `===`

`header === config.webhookSecret`. Every other adapter in the library uses
`constantTimeEqual` for exactly this comparison. `req.headers` is typed
`string | string[] | undefined`, so a framework that hands back an array also
fails the check for the wrong reason.

### `account.channelAccountId` is `'self'` on callback queries

Real updates carry the bot's identity; button taps get a placeholder, so the two
inbound paths disagree about who received the message.

## Sound

`reply_parameters` (Bot API 7.0+) rather than the deprecated
`reply_to_message_id`; `MarkdownV2`/`HTML` parse modes wired to
`TextContent.format`; inline vs reply keyboards both supported; largest photo
size chosen from the `photo` array; `externalId` set on both inbound paths;
error codes carry the HTTP status, so the hub's retry check works here.
