# plivo

`@msgly/plivo` — SMS/MMS API. Reviewed: `send`, `handleWebhook`,
`verifySignature`, status mapping.

## Medium

### The status mapper is exported and never called

`export function mapPlivoStatus(...)`
([index.ts:113](../../packages/adapter-plivo/src/index.ts:113)) has no caller
anywhere in the repo. `config.statusCallbackUrl` exists and is sent as `url` on
every message, and `handleWebhook` recognises the callback specifically in order
to drop it: `if (params['Status'] && !text) return []`. So the delivery-receipt
path is three-quarters built and wired to nothing.

### Failures are unclassified

`plivo_${res.status}` — the HTTP status at least lets the hub skip a retry on
401/403/400, but Plivo's own failure reasons never reach the receipt and no
failure is ever recipient-fatal, so an invalid number stays in the audience.

### Only the first inbound media part is read

MMS with several parts yields one.

## Low

### Local validation failures are retried

`plivo_unsupported_content` and `plivo_media_url_required` are decided before any
network call.

## Sound

Plivo's V3 signature scheme is implemented correctly, including the
comma-separated multiple signatures that appear during key rotation — a detail
most integrations miss. `downloadMedia` carries `mediaRef.filename` through.
`externalId` is set from `MessageUUID`.
