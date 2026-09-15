# exotel

`@msgly/exotel` — SMS API. Reviewed: `send`, `handleWebhook`,
`verifySignature`, status mapping.

## Medium

### Delivery callbacks are dropped

`if (params['Status'] && !body) return []` — with a comment correctly
identifying them as delivery receipts. `mapExotelStatus` exists and is used for
the *send* response, not for the callback, so the final delivery state never
reaches a caller.

### Failures are unclassified

`exotel_${data.RestException?.Status ?? res.status}` puts the HTTP status in the
code, so the hub's retry check works — but nothing is ever marked
recipient-fatal, so a dead number stays in the audience.

### Verification falls open without a token

`if (!config.webhookToken) return true`, documented as insecure. Exotel offers no
signature, so a URL token is the only guard available; defaulting to accepting
anything means an endpoint left unconfigured takes messages from anyone.

## Low

### Local validation failures are retried

`exotel_unsupported_content` is decided before any network call.

## Sound

`RestException.Status` is read out of Exotel's unusual error envelope rather than
falling back to the HTTP status blindly. `DateReceived`/`Date` are parsed for the
inbound timestamp instead of using arrival time. Both `SmsSid` and `MessageSid`
are accepted, since Exotel is inconsistent about which it sends. The token check
is constant-time when a token is set.
