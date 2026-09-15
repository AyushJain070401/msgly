# slack

`@msgly/slack` — Web API + Events API. Reviewed: `send`, `callApi`,
`handleWebhook`, `verifySignature`, capabilities.

## Medium

### One error code for every failure

`callApi` throws a generic `Error` and `send` catches it into
`code: 'slack_send_failed'`
([index.ts](../../packages/adapter-slack/src/index.ts)). Slack's `error` field is
one of the most actionable in any chat API — `channel_not_found`,
`not_in_channel`, `is_archived`, `invalid_auth`, `msg_too_long`,
`rate_limited` — and all of it ends up as prose inside `message`. Nothing can
branch on it, and the hub retries `invalid_auth` three times.

### `channel_not_found` never suppresses

A deleted channel or a user who cannot be DM'd is recipient-fatal and carries no
`permanent` flag, so it stays in the audience.

### `Retry-After` is ignored on 429

Slack's is typically 30 seconds and `chat.postMessage` is metered at roughly
1/second per channel. The hub's 500ms retry lands well inside the window.

### A non-URL image ref throws

`throw new Error('Slack image blocks require a public URL media reference')`,
where the same function returns a receipt for unsupported content types. Thrown,
so it is retried three times.

## Low

### Text is not capped at Slack's limit

`chat.postMessage` rejects a body over ~4000 characters with `msg_too_long`.
Nothing truncates or splits.

## Sound

Signature verification is complete: constant-time HMAC plus a 5-minute replay
window. `bot_id` and subtype filtering prevents reply loops
([index.ts:487](../../packages/adapter-slack/src/index.ts:487)). Threading honours
both the older `metadata.threadTs` and the cross-channel `replyTo`, with the
precedence documented. Capabilities are honest — `image` only, and `send()`
supports exactly that. Assistant thread events are handled explicitly.
