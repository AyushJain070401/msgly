# @msgly/twilio-voice

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

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0

## 1.7.0

### Minor Changes

- 96b9252: Fix the Twilio Voice response model, which could not work as designed, and close
  the gaps between what the adapter claimed and what it did.

  **Callers heard each other's TwiML.** The adapter buffered the reply in a single
  `pendingTwiml` variable shared by every call. The hub calls `getInteractionAck`
  _before_ `handleWebhook` and responds immediately, so the value was always one
  request stale: the first caller got the literal string `ok` as their TwiML
  document (invalid, so the call dropped), and every caller after that heard the
  response meant for the previous one — including a different person's. There was
  no test for `send()` or `getInteractionAck`, which is how it survived.

  A phone call is request/response: Twilio holds the HTTP request open and speaks
  whatever comes back, so the reply has to be produced _during_ that request.
  There is now a `respond(message)` config hook that does exactly that, per
  request, with no shared state. It is deliberately synchronous — Twilio abandons
  a webhook after ~15s and an `await` there is dead air on the line.

  `send()` no longer buffers anything. It drives a call that is already in
  progress through Twilio's REST API (`POST /Calls/{Sid}`), keyed on
  `metadata.callSid` from the inbound message, which is the only way Twilio lets
  you change a live call. Without a CallSid it fails with a message pointing at
  `respond` instead.

  **`capabilities.media.audio` was `true` while `send()` rejected everything but
  text.** Because the flag said yes, the hub passed audio through and the adapter
  then failed it at runtime, instead of the hub refusing it cleanly. Audio now
  maps to `<Play>`, and a non-URL `mediaRef` is rejected with the reason (Twilio
  fetches the file itself, so an uploaded media id means nothing to it).

  **The README documented an interactive `<Gather>` mapping that did not exist**
  — `interactive.buttons` was `false` and `send()` refused the content type.
  Implemented: buttons map to DTMF digits by position, and the keypress comes back
  as an inbound text message containing the digit.

  **Unverifiable webhooks are now rejected.** `verifySignature` previously
  returned `true` when `webhookUrl` was unset. The signature covers the full URL,
  so without one there is nothing to verify — and accepting anyway let anyone who
  found the endpoint fake calls and drive the IVR. Set
  `allowUnsignedWebhooks: true` where something else authenticates the request.
  This is the one behaviour change that can affect an existing deployment: if you
  run without `webhookUrl`, you were never verifying anything, and now you must
  say so explicitly.

  Also added: `parseStatuses()` turning call progress into delivery receipts
  (ringing → sent, answered → delivered, completed → read, with busy and no-answer
  marked transient and only a failed call permanent, so a busy signal never
  suppresses a number); `updateCall()` and `endCall()`; and `downloadMedia()`,
  which now fetches `<Record>` recordings — they sit behind account credentials
  and Twilio only serves them with a file extension, so both are handled.

  Tests went from 16 to 40, covering the request/response path, the REST send,
  status mapping and call control — none of which had any coverage before.

### Patch Changes

- @msgly/core@1.7.0

## 1.6.0

### Patch Changes

- Updated dependencies
  - @msgly/core@1.6.0

## 1.5.0

### Patch Changes

- Updated dependencies [1d98daa]
  - @msgly/core@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [27fa311]
  - @msgly/core@1.4.0

## 1.3.0

### Patch Changes

- Updated dependencies [f88b420]
  - @msgly/core@1.3.0

## 1.2.0

### Patch Changes

- Updated dependencies [7bae280]
  - @msgly/core@1.2.0

## 1.1.0

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [d0aefc7]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0

## 1.1.0

### Patch Changes

- Updated dependencies [20e7146]
- Updated dependencies [8f5aa23]
- Updated dependencies [1abb35e]
- Updated dependencies [20e7146]
- Updated dependencies [cacc6be]
- Updated dependencies [e919523]
- Updated dependencies [dd8ce7d]
- Updated dependencies [3aa2fdc]
- Updated dependencies [20e7146]
- Updated dependencies [0b22265]
- Updated dependencies [c89d542]
- Updated dependencies [3e28485]
- Updated dependencies [1abb35e]
  - @msgly/core@1.1.0
