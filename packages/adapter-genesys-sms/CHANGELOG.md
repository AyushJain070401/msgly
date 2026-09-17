# @msgly/genesys-sms

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
