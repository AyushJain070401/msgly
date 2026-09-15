# sendgrid

`@msgly/sendgrid` — v3 Mail Send, Event Webhook and Inbound Parse. Reviewed:
`send`, `parseDeliveryEvents`, `handleWebhook`, `verifySignature`.

## Medium

### Inbound Parse messages cannot be deduplicated

The inbound message sets no `externalId`
([index.ts:405](../../packages/adapter-sendgrid/src/index.ts:405)), so the hub
cannot drop a repeat. SendGrid retries Inbound Parse POSTs when your endpoint
does not return 2xx, and the parsed email carries a `Message-ID` header that
would serve perfectly as the key.

### Inbound Parse falls open when no token is set

`verifySignature` verifies the Event Webhook signature when the key and headers
are present, and then returns `true` if `inboundToken` is unset. Inbound Parse
is unsigned, so the URL token is the only guard there is — defaulting to
accepting anything means an unconfigured endpoint takes mail from anyone who
finds it.

### Send failures are unclassified

`sendgrid_${res.status}` carries the HTTP status, so the hub's retry check works
— but a 400 naming an invalid address never sets `permanent`, so the address is
only suppressed if and when the asynchronous bounce event arrives.

## Low

### `sendgrid_unsupported_content` is retried

Decided before any network call.

## Sound

`isPermanentFailure` on the event webhook distinguishes a bounce from a block
with a comment explaining the difference — a block is the receiving server
refusing *you* temporarily, and treating it as permanent would suppress people
who are fine. That is exactly the distinction most integrations get wrong.
`recipientId` is set on delivery events. The Event Webhook's ECDSA signature is
verified properly when configured. `In-Reply-To`/`References` are set from
`metadata.messageId`.
