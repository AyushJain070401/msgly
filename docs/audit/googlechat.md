# googlechat

`@msgly/googlechat` — Chat API with a service-account JWT. Reviewed: `send`,
`handleWebhook`, `verifySignature`, capabilities.

## Medium

### Inbound attachments are ignored

`handleWebhook` reads `message.argumentText || message.text` and returns `[]`
when both are empty ([index.ts](../../packages/adapter-googlechat/src/index.ts)).
A person dropping an image or a PDF into the space produces an event with
`message.attachment` and little or no text, so it arrives as nothing at all.

### Google's `error.status` defeats the hub's retry check

`googlechat_${data.error?.status ?? data.error?.code ?? res.status}` —
`status` is the gRPC name (`PERMISSION_DENIED`, `RESOURCE_EXHAUSTED`), so
nothing matches an HTTP status and every failure is retried three times.
`RESOURCE_EXHAUSTED` in particular gets hammered rather than backed off, against
a quota of roughly 60 writes/minute per space.

### `replyTo` is ignored

Google Chat threads on `thread.name`, which the adapter already reads inbound
into `metadata.threadName` — but `send()` never sets it, so every reply starts a
new thread.

## Low

### Verification falls open without `projectNumber`

`if (!config.projectNumber) return true` — documented as insecure, but it is the
default shape of the config and nothing warns at construction time.

### `interaction.id` is the sender, not the event

On `CARD_CLICKED`, `interaction: { id: senderId, data: action }`. Every other
adapter puts the platform's callback id there.

## Sound

The JWT check is thorough: `alg` pinned to RS256 (so `none` and HS256-with-the-
public-key confusion are both blocked), `kid` required, JWKS fetched and cached,
issuer and audience checked, `exp`/`nbf` bounded. The bot's own posts are
filtered by `sender.type === 'BOT'`. Lifecycle events are explicitly skipped
rather than falling through. `externalId` is set from `message.name` on both
inbound paths, and the space is used consistently as the conversation id.
