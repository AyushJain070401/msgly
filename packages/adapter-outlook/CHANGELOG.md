# @msgly/outlook

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

- 20e7146: Add attachment support and paced campaign sending.

  **Attachments** — messages can now carry files alongside their content via a new
  `attachments` array, with `Attachment` and `AttachmentsConfig` types in core.
  Support is opt-in per channel: pass `attachments: { enabled: true }` to an
  adapter's config. Until you do, that adapter reports no file capability and the
  hub rejects attachment sends rather than dropping them silently.

  Gmail and Outlook gain full send and receive support — Gmail builds proper MIME
  multipart bodies (including inline `cid:` images), Outlook uses Graph's
  `fileAttachment` array. Inbound attachments are lazy: you get metadata and a
  reference, and call `downloadMedia()` when you actually want the bytes.

  **Campaigns** — new `hub.sendBulk()` fans one message out to many contacts with
  concurrency control and per-channel rate limiting (a dependency-free token
  bucket, with conservative defaults per platform in `CHANNEL_RATE_LIMITS`).
  Content can be a function so each recipient gets their own template variables.
  Individual failures never abort the run — `sendBulk` resolves with per-recipient
  results and a `failures` list. Supports `AbortSignal` cancellation and an
  `onProgress` callback. Adapters can advertise their own ceiling via a new
  optional `Adapter.rateLimit`.

  All changes are additive — existing code is unaffected.

- 5cbc24c: Add `List-Unsubscribe` support to the Gmail and Outlook adapters, completing
  the set — all five email adapters now emit one-click unsubscribe headers via an
  `unsubscribe` config, overridable per message.

  **Gmail** threads the headers through both MIME builders (plain and multipart),
  so they survive whether or not the message carries attachments.

  **Outlook** needed a different approach: Graph's JSON `internetMessageHeaders`
  only accepts custom `x-` prefixed headers and silently drops
  `List-Unsubscribe`, so configuring `unsubscribe` now routes the send through
  Graph's MIME endpoint instead. That path builds RFC 5322 directly (multipart
  when attachments are present) and enforces Graph's 4 MB MIME ceiling with a
  clear error rather than a raw 413.

  Header values are CRLF-sanitized on both adapters, so an unsubscribe URL
  arriving from metadata cannot inject additional headers.

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

- 20e7146: Add attachment support and paced campaign sending.

  **Attachments** — messages can now carry files alongside their content via a new
  `attachments` array, with `Attachment` and `AttachmentsConfig` types in core.
  Support is opt-in per channel: pass `attachments: { enabled: true }` to an
  adapter's config. Until you do, that adapter reports no file capability and the
  hub rejects attachment sends rather than dropping them silently.

  Gmail and Outlook gain full send and receive support — Gmail builds proper MIME
  multipart bodies (including inline `cid:` images), Outlook uses Graph's
  `fileAttachment` array. Inbound attachments are lazy: you get metadata and a
  reference, and call `downloadMedia()` when you actually want the bytes.

  **Campaigns** — new `hub.sendBulk()` fans one message out to many contacts with
  concurrency control and per-channel rate limiting (a dependency-free token
  bucket, with conservative defaults per platform in `CHANNEL_RATE_LIMITS`).
  Content can be a function so each recipient gets their own template variables.
  Individual failures never abort the run — `sendBulk` resolves with per-recipient
  results and a `failures` list. Supports `AbortSignal` cancellation and an
  `onProgress` callback. Adapters can advertise their own ceiling via a new
  optional `Adapter.rateLimit`.

  All changes are additive — existing code is unaffected.

- 5cbc24c: Add `List-Unsubscribe` support to the Gmail and Outlook adapters, completing
  the set — all five email adapters now emit one-click unsubscribe headers via an
  `unsubscribe` config, overridable per message.

  **Gmail** threads the headers through both MIME builders (plain and multipart),
  so they survive whether or not the message carries attachments.

  **Outlook** needed a different approach: Graph's JSON `internetMessageHeaders`
  only accepts custom `x-` prefixed headers and silently drops
  `List-Unsubscribe`, so configuring `unsubscribe` now routes the send through
  Graph's MIME endpoint instead. That path builds RFC 5322 directly (multipart
  when attachments are present) and enforces Graph's 4 MB MIME ceiling with a
  clear error rather than a raw 413.

  Header values are CRLF-sanitized on both adapters, so an unsubscribe URL
  arriving from metadata cannot inject additional headers.

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
