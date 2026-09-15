# msg91

`@msgly/msg91` — Flow API. Reviewed: `send`, `handleWebhook`,
`verifySignature`.

## Medium

### A failure is coded `msg91_200`

MSG91 answers HTTP 200 with `{ type: 'error' }`, which the adapter handles
correctly — and then labels the receipt `msg91_${res.status}`
([index.ts:266](../../packages/adapter-msg91/src/index.ts:266)). So a failed send
carries the code `msg91_200`, which reads as success and matches nothing useful.
The reason MSG91 actually returned is in `data.message`, as prose.

### Delivery reports are dropped

`handleWebhook` notes that delivery reports reuse the endpoint and returns `[]`
for them. MSG91's DLR carries the operator's verdict, which on DLT-routed Indian
SMS is the only place a template or header rejection shows up.

### Failures are unclassified

No `permanent`, no `retryable`. An invalid mobile number is retried three times
and never suppressed.

## Low

### Local validation failures are retried

`msg91_missing_template` is a configuration mistake — no template id anywhere —
and is retried three times before surfacing.

## Sound

The DLT model is handled properly, which is the whole difficulty of this
channel: every SMS needs an approved template, `text` content is mapped into a
template variable rather than sent raw, and the error text names all three ways
to supply the template id. `normalizeMobile` exists. The `type: 'success'` check
has a comment explaining why the HTTP status cannot be trusted. Token comparison
is constant-time.
