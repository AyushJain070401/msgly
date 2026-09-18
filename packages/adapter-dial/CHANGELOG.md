# @msgly/dial

## 1.10.0

### Minor Changes

- 18adeef: Verify the configured phone number at setup time, not at first send.

  Until now these five adapters checked their number was non-empty and nothing
  more. A number with the country code missing, or one belonging to a different
  account entirely, sailed through `verifyCredentials()` and only surfaced later
  as an opaque provider error on a real send — far from the screen where it was
  typed.

  Each adapter now exposes **`verifyPhoneNumber()`**, and `verifyCredentials()`
  calls it, so the normal setup flow gets the check for free and reports which
  field is actually wrong: the key, the secret, or the number. It is exposed
  separately for the case where the number is changed on an already-connected
  account, and for showing the number's status apart from the credential status.

  The check has two stages. First a local E.164 format gate — `isValidE164` and
  `describeE164Problem`, new in `@msgly/core`, which name the specific mistake
  ("missing the leading +", "strip spaces, dashes") rather than saying invalid.
  Then a provider lookup that answers the question a format check cannot: is
  this number actually on this account?

  - **Twilio** — `GET /2010-04-01/Accounts/{SID}/IncomingPhoneNumbers.json`
  - **Genesys SMS** — `GET /api/v2/routing/sms/phonenumbers`
  - **Genesys Voice** — `GET /api/v2/telephony/providers/edges/dids`
  - **Dial** — no extra request: `verifyCredentials` already fetched
    `/api/v1/phone-numbers` and discarded the body. Dial's `fromNumber` may be an
    id, an E.164 number, or a nickname, so it matches on any of them and skips
    the E.164 gate, which would reject two of the three valid forms.

  **An unanswerable lookup is not a failure.** `PhoneNumberCheckResult.status`
  has four values, not two: `owned`, `not_owned`, `malformed`, and
  `inconclusive`. A Genesys OAuth client without `routing:smsPhoneNumber:view`,
  or a restricted Twilio key that cannot list numbers, cannot answer the
  ownership question — reporting that as `not_owned` would make working
  credentials look broken over a missing read permission. Those cases return
  `ok: true` with `status: 'inconclusive'` and a hint explaining why, so only a
  definite `not_owned` or `malformed` fails the check.

  **The provider endpoints are modeled, not fetched.** Twilio's
  `IncomingPhoneNumbers` resource is well documented; the Genesys inventory/DID
  paths and Dial's number-list envelope are written from platform knowledge, the
  same caveat the Genesys adapters already carry throughout. This is why an
  unanswerable lookup fails open: if a path or envelope is wrong, the check
  reports `inconclusive` and setup still succeeds, rather than rejecting a valid
  number. Dial's matcher accepts a bare array plus the plausible wrappers
  (`phoneNumbers`, `phone_numbers`, `data`, `numbers`, `entities`) for the same
  reason.

  Note that `verifyCredentials()` on these five adapters now fails when the
  number is wrong, where before it only checked the key. `@msgly/dial`'s existing
  "healthy key" test fixture had to gain a number for this reason — an empty
  number list now legitimately means "that number is not on this account".

  `@msgly/dial` additionally exports `matchDialFromNumber(body, fromNumber)`,
  the pure matcher behind its check, for callers that already hold a number list.

  Existing `verifyCredentials()` callers need no change: the return type is
  unchanged, and `accountInfo` keeps its current format on success.

### Patch Changes

- Updated dependencies [18adeef]
  - @msgly/core@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [90e48f6]
  - @msgly/core@1.9.0

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
