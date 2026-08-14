---
'@msgly/core': minor
'@msgly/gmail': minor
'@msgly/outlook': minor
---

Add attachment support and paced campaign sending.

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
