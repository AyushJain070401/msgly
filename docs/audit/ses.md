# ses

`@msgly/ses` — SES v2 with SNS event notifications. Reviewed: `send`,
`parseDeliveryEvents`, `handleWebhook`, `verifySignature`.

## Medium

### The SNS signature is not actually verified

The adapter is honest about this in a comment: verifying SNS's RSA signature
needs X.509 parsing that Web Crypto does not provide, so instead it validates
that `SigningCertURL` points at a genuine AWS host and is reachable
([index.ts](../../packages/adapter-ses/src/index.ts)). That check stops a random
attacker pointing you at their own certificate, but it does not prove the
payload was signed — anyone who can POST to your endpoint with a well-formed
envelope naming a real AWS cert URL passes.

For a channel whose notifications drive *suppression*, a forged bounce is a way
to get someone's address suppressed. Worth either a documented warning at the
config level or an optional verification hook.

### SES error types defeat the hub's retry check

`ses_${type ?? res.status}` — SES's error `type` is a string
(`MessageRejected`, `MailFromDomainNotVerified`), so nothing matches an HTTP
status and every failure is retried three times.

## Low

### `ses_unsupported_content` is retried

Decided before any network call.

## Sound

The best bounce handling in the library, and the model the other email adapters
should follow: `bounceType === 'Permanent'` maps to `permanent: true` and
anything else does not, complaints set `complaint: true`, and there is a comment
explaining that SES's own permanent/transient split maps directly onto what core
expects. `recipientId` is set, which almost nothing else does. The
`SigningCertURL` is validated *before* being fetched, with a comment saying why
— the untrusted-URL-fetch trap avoided deliberately. `skipSnsVerification` is an
explicit opt-out rather than a silent default.
