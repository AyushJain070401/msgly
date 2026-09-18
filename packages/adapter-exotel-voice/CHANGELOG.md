# @msgly/exotel-voice

## 1.10.0

### Patch Changes

- Updated dependencies [18adeef]
  - @msgly/core@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [90e48f6]
  - @msgly/core@1.9.0

## 1.8.0

### Minor Changes

- 79a2749: Add Mailgun, Postmark and Exotel Voice.

  **`@msgly/mailgun`** covers sending, inbound routes and signed event webhooks.
  Mailgun already draws the distinction email actually needs, in its `severity`
  field: a `permanent` failure is a dead mailbox, a `temporary` one is a full
  inbox or a greylist. That maps straight onto core's `permanent`, so bounces
  suppress and deferrals do not.

  Two details that cost people an hour each are handled explicitly. Mailgun keeps
  EU-region domains on a different host, and pointing at the wrong one returns a
  404 that reads exactly like a missing domain — `region: 'eu'` switches it, and
  `verifyCredentials` names the possibility when a lookup 404s. And the webhook
  signing key is a _different_ value from the API key; using one for the other
  produces a verification that silently never matches.

  Inbound attachments stay lazy: the message carries Mailgun's storage URL and the
  bytes are only fetched when `downloadMedia` is called, which keeps a mailbox full
  of large attachments from becoming a memory problem. Inline images go on
  Mailgun's `inline` field rather than `attachment`, which is what makes `cid:`
  references resolve in an HTML body.

  **`@msgly/postmark`** covers sending, inbound parsing and bounce webhooks.

  Postmark answers **HTTP 200 with a non-zero `ErrorCode`** on failure, so the
  adapter reads the code rather than trusting the status line. `406` is the one
  worth knowing: Postmark already has that address suppressed from an earlier hard
  bounce and refused to send — reported as recipient-fatal, so your list agrees
  with theirs instead of retrying forever. Message streams are first-class,
  because Postmark refuses a send on the wrong one and campaigns down the
  transactional stream get accounts reviewed.

  Postmark does not sign webhooks at all, so a URL token is the only guard short
  of IP allow-listing. With none configured `verifySignature` rejects rather than
  accepting whatever arrives: an unverified bounce webhook is a way for anyone to
  get your recipients suppressed.

  **`@msgly/exotel-voice`** is deliberately narrower than the other three voice
  adapters, because the platform is.

  Twilio, Plivo and Vonage all let you return TwiML, Plivo XML or an NCCO from a
  webhook and have the caller hear it. Exotel does not — what a caller hears comes
  from an App Bazaar flow built in the dashboard, and the API places and bridges
  calls into it. So this adapter declares `text: false` and no media, rather than
  claiming a capability `send()` could never honour. What it does offer is what
  Exotel is genuinely good at: `connectNumbers()` for click-to-call (the Indian
  marketplace pattern of connecting two people without either seeing the other's
  number), `connectToFlow()` for IVR dialling, inbound Gather webhooks, and
  `parseStatuses()` for outcomes. `send()` maps to flow dialling, and without a
  flow id it fails with a message pointing at `connectNumbers()` rather than
  failing vaguely.

  Across all three voice adapters the permanence rule is the same: only a genuinely
  failed call marks the number recipient-fatal. Busy and no-answer are the person,
  not the line.

  `@msgly/core` registers `mailgun`, `postmark` and `exotel-voice` in
  `KnownChannel` and the per-channel rate-limit table.

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
