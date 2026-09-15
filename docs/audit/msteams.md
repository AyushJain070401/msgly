# msteams

`@msgly/msteams` — Bot Framework. Reviewed: `send`, `toTeamsActivity`,
`handleWebhook`, `parseAttachment`, `verifySignature`.

## High

### An attachment is dropped whenever there is also text

```ts
if (activity.text) {
  content = { type: 'text', text: activity.text };
} else if (activity.attachments && activity.attachments.length > 0) {
```
([index.ts:558](../../packages/adapter-msteams/src/index.ts:558)) — Teams sends
both fields on a message with a caption, which is the normal way a person shares
a file. The text is kept and the file is silently discarded. There is no second
message and nothing in `metadata` to recover it from.

## Medium

### The caption is used as the filename

`name: content.caption`
([index.ts:380](../../packages/adapter-msteams/src/index.ts:380)) — `name` is the
filename Teams displays. A caption lands there, and `mediaRef.filename` is never
read. With no caption the field is `undefined` and Teams shows the raw URL.

### Bot Framework error codes defeat the hub's retry check

`msteams_${data.error?.code ?? res.status}` — Graph/Bot Framework codes are
strings (`BotNotRegistered`, `ServiceError`, `Throttled`), so nothing matches an
HTTP status and every failure is retried three times, including a bad app
password.

### `replyTo` is ignored

Teams threads on `replyToId` in the activity. Nothing reads `message.replyTo`,
so a reply posts as a new message in the conversation.

## Low

### Media types collapse to one attachment shape

Image, video, audio and file all produce the same attachment differing only in
fallback MIME type. That matches Bot Framework's model, but combined with the
`name` bug above it means a video and a PDF are indistinguishable to the
recipient when no caption is set.

## Sound

JWT verification against the Bot Framework JWKS with issuer and audience pinned
and clock skew bounded — no missing-secret bypass, the strongest inbound check
in the library alongside Google Chat's. `metadata.serviceUrl` is required with a
message that says where to get it, rather than failing deep in a fetch. Card
actions (button presses) are surfaced as text so the same handler matches them.
Hero card buttons are capped at 6 and labels at 80 characters, both real Teams
limits.
