---
'@msgly/tiktok': minor
'@msgly/core': minor
---

Add `@msgly/tiktok` — video and photo publishing, comment replies and direct messages.

`publishVideo()` posts by URL pull or direct byte upload, in `DIRECT_POST` or
`INBOX` mode, and `publishPhotos()` posts carousels. Publishing is asynchronous
on TikTok's side, so both return a `publishId` for `getPublishStatus()`, and the
`post.publish.complete` webhook is surfaced through `onEvent()`. Privacy level
defaults to `SELF_ONLY`, because an unaudited app may only post privately.

`send()` covers both messaging surfaces, routed by `metadata.kind`. Comment
replies use the public Comment API and work with no extra setup; inbound
comments carry `videoId` and `commentId`, so replying straight back needs no
lookup. **Direct messages require `config.directMessages`**: TikTok publishes no
DM API on the open developer platform, and the business/partner messaging host
and auth differ per partner, so the endpoint is configuration rather than a
hardcoded URL. Unconfigured, a DM send fails with `tiktok_dm_not_configured` and
an explanation instead of being silently dropped.

Handles the TikTok-specific traps: the API returns **HTTP 200 with
`error.code: "ok"`** rather than signalling through status codes, so the
envelope is treated as the real result, with rate limits retryable and revoked
scopes permanent; `PULL_FROM_URL` failures name the URL-ownership verification
step; and the live API's misspelled `publicaly_available_post_id` field is read
under both spellings.

`send()` is text-only on both surfaces and the declared capabilities say so:
publishing sits outside `send()`, like `publishPost()` on the feed adapters, so
claiming media support here would make the hub wave a video message through to a
`send()` that must reject it.

Comments have no webhook, so inbound is polled per video with persistable
cursors — the first poll of an unseen video records the high-water mark without
replaying its history. Webhook signatures are verified against TikTok's
`t=…,s=…` HMAC-SHA256 scheme over the raw body, with a `webhookToleranceSec`
window (default 300) bounding replay of a captured request.
