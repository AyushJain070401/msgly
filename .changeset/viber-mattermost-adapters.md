---
'@msgly/viber': minor
'@msgly/mattermost': minor
'@msgly/core': minor
---

Add `@msgly/viber` and `@msgly/mattermost`.

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
