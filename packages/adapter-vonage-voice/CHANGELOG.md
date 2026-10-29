# @msgly/vonage-voice

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

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
