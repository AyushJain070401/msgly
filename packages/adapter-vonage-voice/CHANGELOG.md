# @msgly/vonage-voice

## 1.8.0

### Minor Changes

- 79a2749: Add Plivo Voice and Vonage Voice, taking voice from one provider to three.

  Both follow the request/response model `@msgly/twilio-voice` was rewritten to
  use in this release, because a phone call genuinely is request/response: the
  provider holds the HTTP request open and speaks whatever comes back. That reply
  cannot come from the hub's `on('message')` handler, which runs _after_ the
  response has already been sent. So both take a `respond(message)` hook that
  produces the answer inside the webhook request, with no shared state — and both
  are deliberately synchronous, since an `await` there is dead air on the line.

  **`@msgly/plivo-voice`** speaks Plivo XML and reuses the Auth ID and Token from
  `@msgly/plivo`, so one set of credentials covers SMS and voice. Text is
  XML-escaped, which matters more than it sounds: an ampersand in a customer's
  name would otherwise break the whole document. Plivo redirects a live call to a
  URL rather than accepting XML inline, so `send()` needs `metadata.transferUrl`
  and says so in the error rather than failing vaguely.

  Webhook verification uses Plivo's V3 scheme and accepts the several
  comma-separated signatures sent during key rotation. Without a `webhookUrl`
  there is nothing to verify, so it rejects rather than accepting blindly —
  `allowUnsignedWebhooks` is the explicit opt-out, matching Twilio Voice.

  **`@msgly/vonage-voice`** speaks NCCO and authenticates with a signed
  application JWT — an Application ID plus a private key, _not_ the
  api_key/api_secret pair `@msgly/vonage-sms` uses. Two separate credentials on
  one account, and mixing them up is the first thing that goes wrong, so
  `verifyCredentials` names the distinction directly. Each JWT carries its own
  `jti` because Vonage rejects a replayed token.

  Vonage accepts a transfer NCCO inline, so `send()` redirects a live call with no
  extra endpoint to host.

  It does not pretend to verify webhooks: Vonage signs voice callbacks only when
  the application is configured for it, over a JWT in the `Authorization` header
  rather than the body. `verifySignature` returns `true` and the README says
  plainly that this means unverified, rather than implying a check that is not
  happening.

  Both map `interactive` content to keypad digits — a phone has no screen, so each
  button becomes the digit at its position and the prompt reads them out — and
  both expose `parseStatuses`, where the permanence rule is the one that matters:
  only a failed or rejected call marks the number recipient-fatal. Busy and
  no-answer are the _person_, not the line. They may answer next time, and
  suppressing there quietly deletes a live customer.

  `@msgly/core` registers both in `KnownChannel` and the rate-limit table, at a
  deliberately low rate: a call holds a line for its whole duration, so throughput
  is bounded by concurrent channels rather than requests per second.

### Patch Changes

- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
