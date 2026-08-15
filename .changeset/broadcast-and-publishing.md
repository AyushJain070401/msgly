---
'@msgly/line': minor
'@msgly/wechat': minor
'@msgly/viber': minor
'@msgly/instagram': minor
'@msgly/messenger': minor
---

Add native broadcast and feed publishing.

`sendBulk` fans a message out per recipient, which is right for email and SMS
but wrong for the channels that have a real broadcast primitive — reaching
100,000 LINE friends should be one request, not 100,000.

- **LINE** — `broadcast()` reaches every friend in one call, `multicast()` takes
  a segment of up to 500, and `getQuotaRemaining()` reports the plan quota left.
  Both accept a retry key, so a network timeout cannot double-send a campaign.
- **WeChat** — `massSend()` to all followers or one tag group, and
  `massSendToUsers()` for up to 10,000 openids. An exhausted quota (4/month for
  Service Accounts) is reported as a *retryable* failure with the limit spelled
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
