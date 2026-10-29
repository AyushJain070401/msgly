# @msgly/exotel-voice

## 1.12.0

### Minor Changes

- 48807cc: Close the parity gaps left by 1.10 and 1.11: setup-time number checks on the
  rest of the phone channels, and a chat link for Dial.

  **`verifyPhoneNumber()` on six more adapters.** 1.10 added it to Twilio SMS,
  Twilio Voice, Genesys SMS, Genesys Voice and Dial, which left every other
  number-carrying channel checking only that its sender field was non-empty. All
  six now behave the same way: a local E.164 gate that names the specific mistake
  ("missing the leading +", "strip spaces, dashes"), then a provider lookup
  answering the question a format check cannot — is this number actually on this
  account? `verifyCredentials()` calls it, so the normal setup flow gets the check
  for free and reports which field is wrong.

  - **Plivo** — `GET /v1/Account/{auth_id}/Number/`
  - **Plivo Voice** — the same resource
  - **Vonage SMS** — `GET /account/numbers`
  - **Telnyx** — `GET /v2/phone_numbers?filter[phone_number]=…`
  - **Exotel Voice** — `GET /v1/Accounts/{sid}/IncomingPhoneNumbers.json`
  - **Vonage Voice** — format only, see below

  Plivo and Vonage return their numbers without a leading `+`, so the comparison
  is on digits. `@msgly/core` gains **`phoneDigits`**, **`sameNumber`** and
  **`isAlphanumericSenderId`** for this, next to the existing `isValidE164` and
  `describeE164Problem`.

  **An alphanumeric sender ID is `inconclusive`, not `malformed`.** Plivo, Vonage
  and Telnyx all accept either a number or a registered sender id in the same
  field. A sender id is registered with the destination carrier rather than rented
  on the account, so there is nothing to look it up against — and running the
  E.164 gate on one would reject a working configuration. It reports `ok: true`
  with a hint noting that recipients cannot reply and that several countries
  reject it outright.

  **Vonage Voice is a format check only, deliberately.** Vonage rents numbers at
  the account level and the only endpoint that lists them authenticates with the
  `api_key`/`api_secret` pair `@msgly/vonage-sms` takes; a Voice application JWT
  cannot read it, and `VonageVoiceConfig` has no reason to carry account
  credentials just for a setup check. A well-formed number reports `inconclusive`
  rather than `owned` — the mistakes people actually hit are caught, and the
  ownership question is reported as unanswered rather than guessed at. Vonage
  Voice also takes its number without a leading `+`, unlike every other adapter
  here; the gate accepts either form and names the one Vonage wants.

  **Unanswerable lookups still fail open**, as in 1.10: a key without permission
  to list numbers, or an unexpected response, reports `ok: true` with
  `inconclusive`. Only a definite `not_owned` or `malformed` fails. Exotel Voice's
  endpoint is **modeled, not fetched** — Exotel's v1 API is shaped like Twilio's,
  and several envelopes are accepted — which is exactly why it fails open.

  Note that `verifyCredentials()` on these six adapters now fails when the sender
  is wrong, where before it only checked the credentials. Two existing test
  fixtures had to gain a number for this reason: an empty number list now
  legitimately means "that number is not on this account".

  **`@msgly/dial` gains `getChatLink()`.** 1.11 shipped chat links for every
  channel that has one and listed the omissions, but Dial fell through: it was
  grouped with neither the SMS rails that got `sms:` links nor the senders that
  cannot receive a reply. A Dial line is a real provisioned number, so it gets the
  same `sms:<number>` link, with `text` prefilled and `tracked: false`. One link
  covers the line however it is provisioned — the system messaging app picks
  between SMS/MMS and iMessage itself. It returns `null` when `fromNumber` is a
  phone-number id or a nickname, since neither is something a scanner can dial.

### Patch Changes

- Updated dependencies [48807cc]
  - @msgly/core@1.12.0

## 1.11.0

### Patch Changes

- Updated dependencies [7360206]
- Updated dependencies [7360206]
  - @msgly/core@1.11.0

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
