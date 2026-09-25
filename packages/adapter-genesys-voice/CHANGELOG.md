# @msgly/genesys-voice

## 1.11.0

### Patch Changes

- Updated dependencies [7360206]
- Updated dependencies [7360206]
  - @msgly/core@1.11.0

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

### Minor Changes

- 90e48f6: Add `@msgly/genesys-sms` and `@msgly/genesys-voice` — Genesys Cloud CX
  contact-center messaging and telephony, as a channel-split pair mirroring
  `@msgly/twilio-sms`/`@msgly/twilio-voice`.

  **Auth is OAuth2, not Basic Auth.** Every SMS/voice adapter shipped so far
  authenticates with a static credential pair sent on every request. Genesys
  Cloud instead uses OAuth2 client-credentials: `clientId`/`clientSecret` are
  exchanged for a bearer token (`POST https://login.{region}/oauth/token`),
  cached, and refreshed from the response's `expires_in` before it lapses. Both
  adapters share this token-cache logic, duplicated rather than factored into a
  shared package — two small adapters didn't justify a new internal dependency,
  and the duplication is a handful of lines. `region` also picks the API host
  (`api.{region}`) — Genesys Cloud is region-sharded, and there is no single
  global endpoint the way Twilio has one.

  **Inbound is JSON notifications, not a single synchronous webhook.** Twilio's
  form-encoded POST-per-event model doesn't hold for Genesys Cloud: inbound SMS,
  call events, and status changes all arrive through the Notifications API,
  usually relayed to an HTTP endpoint by a configured webhook integration as a
  JSON body (either a bare event or wrapped `{ topicName, eventBody }`).
  `handleWebhook` on both adapters parses that JSON shape rather than Twilio's
  `application/x-www-form-urlencoded` body — the biggest structural divergence
  from the Twilio template both were built from.

  **Signature verification is a documented assumption, not a fact.** Genesys
  Cloud publishes no single universal webhook-signing header the way Twilio
  documents `X-Twilio-Signature`. Both adapters verify HMAC-SHA256 over the raw
  body against a configurable `webhookSecret` and header name, and — like
  `@msgly/twilio-voice` — reject unverifiable webhooks by default, with an
  explicit `allowUnverifiedWebhooks` escape hatch for callers who authenticate
  requests some other way. Confirm the header/algorithm against your own
  webhook integration before depending on it.

  **`@msgly/genesys-voice` does not invent a fake TwiML.** Twilio Voice can
  build a full IVR inline because TwiML is a documented markup language the
  webhook response returns. Genesys Cloud has no equivalent — flows are authored
  externally in Genesys Architect. Rather than fabricate a DSL, `send()` refuses
  text content outright with an error pointing callers at Architect, and audio
  playback into a live call — which is _not_ a confidently-known single
  Conversations API endpoint — returns an explicit
  `genesys_voice_play_not_implemented` failure instead of guessing at a path.

  Because of that, every capability flag on this adapter is `false`, including
  `media.audio`. The hub gates `send()` on those flags, so advertising audio
  would wave a send through only to fail at runtime, instead of failing fast
  with `UnsupportedFeature` — the exact class of dishonest-capability bug the
  generated capability matrix exists to catch. `@msgly/genesys-voice` is
  therefore an inbound-plus-call-control adapter: `handleWebhook()`,
  `initiateCall()`, `endCall()` and `parseStatuses()` all sit outside `send()`.
  `initiateCall`/`endCall` do call a documented-shape endpoint
  (`POST /api/v2/conversations/calls`, `.../disconnect`), but both are flagged
  in code comments to verify against current Genesys Cloud API docs before
  production use — this was written from platform knowledge, not fetched docs.

  **`@msgly/genesys-sms` stays narrow on purpose.** Text only; no MMS-equivalent
  attachments (the content-management API shape for that isn't modeled), no
  templates, no reactions, no typing. Honest, conservative capabilities over
  guessed-at ones.

  `@msgly/core` registers `genesys-sms` and `genesys-voice` in `KnownChannel`
  and gives both a conservative `CHANNEL_RATE_LIMITS` default — `3/s` for SMS
  (Genesys Cloud's documented messaging-endpoint ceiling is roughly 300
  requests/min per org) and `2/s` for voice (bounded by concurrent
  conversations, same reasoning as the other voice adapters).

### Patch Changes

- Updated dependencies [90e48f6]
  - @msgly/core@1.9.0
