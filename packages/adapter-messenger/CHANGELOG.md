# @msgly/messenger

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

### Minor Changes

- 856cf52: Add native broadcast and feed publishing.

  `sendBulk` fans a message out per recipient, which is right for email and SMS
  but wrong for the channels that have a real broadcast primitive — reaching
  100,000 LINE friends should be one request, not 100,000.

  - **LINE** — `broadcast()` reaches every friend in one call, `multicast()` takes
    a segment of up to 500, and `getQuotaRemaining()` reports the plan quota left.
    Both accept a retry key, so a network timeout cannot double-send a campaign.
  - **WeChat** — `massSend()` to all followers or one tag group, and
    `massSendToUsers()` for up to 10,000 openids. An exhausted quota (4/month for
    Service Accounts) is reported as a _retryable_ failure with the limit spelled
    out, rather than an opaque error code.
  - **Viber** — `broadcast()` to up to 300 subscribers per call. Viber reports
    per-recipient outcomes, so failed ids come back in `metadata.failed` ready to
    feed the suppression store.
  - **Instagram** — `publishPost()` for feed posts and Reels, handling the
    two-step container/publish flow.
  - **Messenger** — `publishPost()` for Facebook Page posts, using the `photos`
    edge for images and `feed` otherwise.

  Publishing is deliberately a separate method rather than part of `send()`: a
  post has no recipient, so forcing it through the message contract would
  misrepresent it.

  Telegram channel posting needed no change — a channel is just another `chat_id`,
  so `@channelname` already worked. That is now documented.

### Patch Changes

- f88b420: Documentation catch-up. The code shipped ahead of the per-package docs, and npm
  users only ever see the package README.

  `@msgly/core`'s README documented none of the campaign or compliance API —
  `sendBulk`, `SuppressionStore`, `applyConsentIntent`, `applyDeliveryReceipt` or
  `List-Unsubscribe` — despite those being the reason to reach for it. All are now
  covered, including the three behaviours that are easy to get wrong: suppressed
  recipients are `skipped` rather than `failed`, an unreachable store skips the
  send instead of proceeding, and only permanent failures suppress.

  The LINE, WeChat, Viber, Instagram and Messenger READMEs now document
  `broadcast`, `massSend`, `publishPost` and friends, with the constraints that
  actually bite: LINE's retry key and monthly quota, WeChat's 4-per-month cap with
  no undo, Viber's per-recipient failure list, Instagram's `igUserId` being the IG
  account id rather than the Page id, and Facebook's `pages_manage_posts` scope.

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
