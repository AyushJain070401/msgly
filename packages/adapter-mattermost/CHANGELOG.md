# @msgly/mattermost

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
