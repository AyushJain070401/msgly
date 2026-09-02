# @msgly/viber

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

### Minor Changes

- 3e28485: Add `@msgly/viber` and `@msgly/mattermost`.

  **Viber** — Business Messages with rich media, keyboards, and HMAC-SHA256
  webhook verification over the raw body. Viber answers HTTP 200 even for
  failures, so the adapter treats the JSON `status` field as the real result
  rather than reporting rejected messages as sent. Keyboards flatten 2D button
  layouts and cap at Viber's 24-button maximum, and the sender name is truncated
  to its 28-character limit. Includes `setWebhook`/`removeWebhook` helpers.

  **Mattermost** — self-hosted team chat over the v4 REST API. Mattermost does not
  sign outgoing-webhook bodies, so a shared `webhookToken` is compared in constant
  time. The bot's own echoed posts are dropped to avoid a reply loop. Because the
  conversation is a channel rather than a person, `contact.channelUserId` carries
  the channel id while the speaking user lands in metadata; replies can be
  threaded via `metadata.postId`. Files attach by id, so `uploadMedia` is required
  and a URL reference fails fast.

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

### Minor Changes

- 3e28485: Add `@msgly/viber` and `@msgly/mattermost`.

  **Viber** — Business Messages with rich media, keyboards, and HMAC-SHA256
  webhook verification over the raw body. Viber answers HTTP 200 even for
  failures, so the adapter treats the JSON `status` field as the real result
  rather than reporting rejected messages as sent. Keyboards flatten 2D button
  layouts and cap at Viber's 24-button maximum, and the sender name is truncated
  to its 28-character limit. Includes `setWebhook`/`removeWebhook` helpers.

  **Mattermost** — self-hosted team chat over the v4 REST API. Mattermost does not
  sign outgoing-webhook bodies, so a shared `webhookToken` is compared in constant
  time. The bot's own echoed posts are dropped to avoid a reply loop. Because the
  conversation is a channel rather than a person, `contact.channelUserId` carries
  the channel id while the speaking user lands in metadata; replies can be
  threaded via `metadata.postId`. Files attach by id, so `uploadMedia` is required
  and a URL reference fails fast.

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
