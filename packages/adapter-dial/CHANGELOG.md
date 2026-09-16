# @msgly/dial

## 1.8.0

### Minor Changes

- 8ad88fb: Add Dial — agent-provisioned numbers, with SMS, MMS and iMessage on one line.

  **`@msgly/dial`** is the first channel here where the _number itself_ is
  programmable. Every other SMS adapter in this library assumes someone has
  already opened an account and bought a line; Dial provisions one from an API.
  That difference stops at the edge of this package, though: provisioning and
  10DLC registration are account lifecycle, not messaging, so they have no place
  in the `Adapter` contract and this adapter covers messaging only.

  A Dial line carries SMS, iMessage, RCS and WhatsApp at once, and Dial derives a
  reply's rail from the message being replied to. Splitting those into separate
  channels would fragment one conversation's history across adapters, so this is a
  single `dial` channel and the rail travels as `metadata.dialChannel`. Set
  `channel` in the config to force one outbound. Inbound WhatsApp currently has no
  value of its own in Dial's published event types — `sms | imessage | rcs |
unknown` — so whatever arrives is preserved verbatim rather than guessed at.

  Dial offers two inbound paths and only one fits: signed HTTP webhooks, and a
  long-lived PubNub subscription through `@getdial/sdk`. The `Adapter` contract is
  webhook-shaped, and taking the SDK would pull `pubnub` and `zod` into a package
  that otherwise needs nothing but `@msgly/core`, so this uses the webhooks.
  `X-Dial-Signature` is `t=<unix>,v1=<hex>` over `"{timestamp}.{rawBody}"`, with a
  timestamp window bounding replay, failing closed on a missing or malformed
  header rather than falling open.

  Delivery and reads are two independent axes in Dial's status events, with
  `changed` naming the one that moved, so every event is a complete snapshot of
  both. `unconfirmed` is the one worth knowing: it means the rail sends no
  delivery receipts at all, so the message left Dial and nothing further will ever
  arrive — that is `sent`, not a failure. Since the `Adapter` interface has no
  receipt hook, `parseStatuses()` exposes them alongside `handleWebhook()`, the
  same shape `@msgly/twilio-voice` uses, so status events are not dropped on the
  floor. Failures are classified on the recipient axis: a dead number suppresses,
  a throttle does not, and anything unrecognised stays transient — wrongly
  suppressing a good number is the worse error.

  `capabilities.reactions` and `capabilities.typing` are both `true` here, and
  both were verified against Dial's published types rather than assumed.
  `replyToMessage` takes exactly one of `{ body }` or `{ reaction }`, enforced at
  the type level, and typing is a real indicator on iMessage that SMS lines ignore
  silently. Reaction _removal_ is deliberately not implemented: other channels use
  an empty string to mean remove, Dial documents no equivalent, and guessing would
  silently send a reaction instead of removing one.

  The rate-limit default is deliberately slow. Texting US numbers needs 10DLC
  brand and campaign registration under your own company's legal identity, and a
  freshly approved brand on a low tier runs roughly 0.25-4 messages per second —
  so the default is `1/s`, to be raised once you know your tier. Voice, inbound
  SMS and texting non-US numbers are unaffected by any of that.

  `@msgly/core` registers `dial` in `KnownChannel` and the per-channel rate-limit
  table.

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
