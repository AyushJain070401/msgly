# @msgly/whatsapp

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

- 79a2749: Fix WhatsApp send-failure handling, which retried failures that could never
  succeed and could not tell a dead number from a throttle.

  **Every failed send was retried three times.** The hub decides retryability by
  looking for an HTTP status inside `error.code`, but WhatsApp answers almost
  everything with HTTP 400 and puts the real cause in `error.code` as its own
  application code. So `wa_190` (access token expired), `wa_100` (invalid
  parameter), `wa_132001` (template does not exist) and `wa_131026` (not a
  WhatsApp user) all sailed past the check and were retried with backoff, burning
  the retry budget and the API quota to arrive at the same failure. The adapter
  now classifies Meta's codes itself, and the core honours that verdict.

  **Failures carried no `permanent` flag**, so suppression stores could never act
  on them: a number that is not on WhatsApp looked exactly like a rate limit and
  stayed in every future campaign.

  The two questions turn out to be different ones, and conflating them is how you
  suppress a whole contact list over a typo in a template name. `DeliveryReceipt.error`
  now has both:

  - `permanent` — is this _recipient_ dead? Set only for `131021` and `131026`.
    This is what suppression reads.
  - `retryable` — could the same request ever succeed? `false` for bad tokens,
    bad parameters, unknown or paused templates, a closed 24-hour window; `true`
    for throttles and Meta-side outages.

  Unrecognised codes leave both `undefined`, which the core reads as "retry, never
  suppress" — wrongly binning a reachable customer is worse than a wasted retry.
  `isRetryableError` consults the adapter's verdict first and falls back to its
  old status-sniffing heuristic only when an adapter says nothing, so no other
  adapter changes behaviour.

  **A failed send and a failed status webhook reported the same Meta error under
  two different codes** — `wa_131026` from `send()`, `131026` from
  `parseStatuses()`. Both now use the prefixed form, so one check covers both
  paths.

  **Meta's error detail was dropped.** `error.message` is usually generic
  (`(#132012) Parameter format does not match format in template`); the sentence
  that says what is actually wrong lives in `error_data.details`. It is now
  appended to the message.

  **Documents lost their filename.** The outbound payload never set `filename`, so
  recipients saw a name derived from the URL — `9f2c` rather than
  `invoice-0042.pdf`. `uploadMedia` also dropped it from the ref it returned, and
  inbound documents never parsed it, so there was no way to round-trip a name.
  Fixed in all three places.

  Also: send receipts now set `recipientId` (the webhook path already did); list
  messages enforce Meta's cap of 10 rows across all sections, filling sections in
  order and dropping any left empty, instead of letting the API reject the whole
  message; and `header`/`footer` are truncated to 60 characters like every other
  label. Body text and row/button `id`s are deliberately left alone — truncating a
  body loses your message, and truncating an `id` silently breaks postback
  matching.

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0

## 1.7.0

### Patch Changes

- @msgly/core@1.7.0

## 1.6.0

### Minor Changes

- Bring the Meta adapters back into API support, and make `reactions`, `typing`
  and message threading real across every channel that has them.

  **Meta Graph API v20.0 → v23.0 (urgent).** `@msgly/whatsapp`, `@msgly/instagram`
  and `@msgly/messenger` all defaulted to `v20.0`, which Meta retires on
  **2026-09-24** — every send on the default config would have started failing on
  that date. The default is now `v23.0` (supported until 2027-10-08). An explicit
  `apiVersion` in config still wins, so anyone already pinning a version is
  unaffected.

  **`reactions` was a dead capability.** Five adapters advertised
  `capabilities.reactions: true` while the library had no way to send one — no
  content type, no method, nothing. `Adapter` now carries an optional
  `sendReaction(contact, externalMessageId, emoji)`, implemented for WhatsApp
  (native `reaction` message), Telegram (`setMessageReaction`), Instagram
  (`sender_action: react`), Mattermost (`POST /reactions`) and Rocket.Chat
  (`chat.react`).

  The platforms disagree about what an emoji _is_, and the adapters surface that
  rather than hiding it: WhatsApp and Telegram take a unicode glyph and clear the
  reaction on an empty string; Mattermost and Rocket.Chat take an emoji _name_
  and remove one named reaction at a time, so they expose `removeReaction` instead
  of overloading the empty string; Instagram accepts only its seven fixed reaction
  names and rejects anything else with the valid list in the error.

  **`typing` flags now match reality.** WhatsApp advertised `typing: false` while
  shipping a working `sendTypingIndicator`, so the flag was talking callers out of
  a feature that existed. Microsoft Teams advertised `typing: true` with no
  implementation at all; it now sends a real `typing` activity, taking the
  conversation's `serviceUrl` as a second argument the way `send` already does,
  and no-ops without one so generic `adapter.sendTyping?.(contact)` stays safe.

  **Message threading (`replyTo`).** `BaseMessage` gains an optional `replyTo`
  carrying the _platform's_ message id. Adapters map it to their native
  equivalent: WhatsApp `context.message_id`, Telegram `reply_parameters` (the
  Bot API 7.0+ replacement for the deprecated `reply_to_message_id`), Discord
  `message_reference` with `fail_if_not_exists: false` so a deleted parent
  degrades to a normal message, and Slack `thread_ts`. Slack's existing
  `metadata.threadTs` still wins where both are set. Channels without threading
  ignore the field rather than failing, so setting it is always safe.

  **WhatsApp list and CTA-URL messages.** `send()` covered one of WhatsApp's seven
  interactive sub-types. New `ListContent` (`type: 'list'`) sends a sectioned
  picker for choice sets too large for three buttons, and `CtaUrlContent`
  (`type: 'cta_url'`) sends a URL button without putting the raw link in the body.
  Both truncate to WhatsApp's field limits rather than letting the API reject the
  send.

  These are gated behind new optional `capabilities.interactive.lists` and
  `capabilities.interactive.ctaUrl` flags. Being optional, every existing adapter
  and any third-party one keeps compiling untouched, and the hub rejects the new
  types with `UnsupportedFeature` on channels that have not opted in — the same
  contract media content already follows.

- Add WhatsApp Coexistence support — the WhatsApp Business app and the Cloud API
  live on the same number, with staff answering from the handset while the API
  automates alongside them.

  Coexistence adds three webhook fields, exported as `COEXISTENCE_WEBHOOK_FIELDS`
  for `setAppWebhookFields`, and each gets its own parser:
  `parseMessageEchoes` for messages staff send from the phone, `parseHistory` for
  the back-fill Meta pushes after onboarding, and `parseContactSync` for the
  business's phone address book. Every parser returns `[]` for a payload that is
  not its own, so a handler can call all of them on each request.

  `handleWebhook` now filters on the change's `field` and returns only genuine
  inbound customer messages. This matters: history and echoes both carry message
  payloads, and routing either into a bot is actively harmful — a back-fill would
  replay up to 180 days of traffic as if it had just arrived, and an echo would
  make the bot reply to its own operator. (A change with no `field` is still
  treated as `messages`, so existing fixtures and older payloads parse unchanged.)

  `parseHistory` labels each message inbound or outbound by comparing the sender
  against the business number on digits alone, because WhatsApp writes that number
  as `+1 555-0100` in history metadata but `15550100` on the message itself.
  Chunks carry `phase`, `chunkOrder` and `progress`, since the back-fill spans
  several webhooks and is only complete at `progress === 100`.

  `requestSmbAppData()` triggers the contact and history sync, and
  `getCoexistenceStatus()` reports `is_on_biz_app` / `platform_type`. Setting
  `coexistence: true` in config makes the adapter advertise
  `rateLimit: { perSecond: 20 }`, the fixed ceiling Meta applies to dual-platform
  numbers, so `sendBulk` paces to the real limit instead of the API-only default.

  The README documents the eligibility gates, which are easy to get wrong:
  Coexistence needs Solution Partner or Tech Provider status and Embedded Signup
  v4 on the integrator side, and on the customer side the WhatsApp Business _app_
  at v2.24.17+ — not merely a WhatsApp Business Account, which every Cloud API
  user already has. It also records the one-time, 24-hour sync limit and the
  features the handset loses once onboarded.

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

- 7d766e2: Cover the outbound path on the three thinnest-tested adapters.

  All of WhatsApp's existing tests were webhook-side, so `send()` — including the
  template branch every campaign depends on — had no coverage at all. Same story
  for Telegram and Instagram.

  Added tests for the parts most likely to break silently: WhatsApp's media
  `id`-vs-`link` selection, the audio caption it rejects, the 3-button interactive
  cap with 20-character labels, and `components` correctly winning over
  `variables` on rich templates. Telegram's per-type method routing, its 2D inline
  keyboard rows (flattening them would lose the grid), reply-vs-inline keyboards,
  `@channelname` posting, and full MarkdownV2 escaping. Instagram's Send API
  payload, `X-Hub-Signature-256` verification against a tampered body, echo-message
  filtering, the GET challenge, and the OAuth helpers.

  Also covers a case each of these shares: a `200` response carrying no message id
  is a failed send, not a successful one.

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
