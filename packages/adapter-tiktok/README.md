# @msgly/tiktok

TikTok adapter for [Msgly](https://github.com/AyushJain070401/msgly) — video and photo publishing, comment replies and direct messages.

```bash
npm install @msgly/core @msgly/tiktok
```

```typescript
import { createHub } from '@msgly/core';
import { createTikTokAdapter } from '@msgly/tiktok';

const tiktok = createTikTokAdapter({
  clientKey: process.env.TIKTOK_CLIENT_KEY!,
  clientSecret: process.env.TIKTOK_CLIENT_SECRET!,
  // Publishing acts as a creator, so this is a user token from the OAuth grant.
  accessToken: process.env.TIKTOK_ACCESS_TOKEN!,
  refreshToken: process.env.TIKTOK_REFRESH_TOKEN,
  openId: process.env.TIKTOK_OPEN_ID,
  postMode: 'DIRECT_POST',
});

const hub = createHub().register(tiktok);
await hub.start();   // begins polling comments
```

Create an app at [developers.tiktok.com](https://developers.tiktok.com/). Scopes:
`user.info.basic`, `video.publish` (or `video.upload` for inbox drafts), and
`comment.list` + `comment.create` for replies.

## Publishing

```typescript
// Pull from a URL — the domain must be verified under the app's URL properties.
const { publishId } = await tiktok.publishVideo({
  videoUrl: 'https://cdn.example.com/launch.mp4',
  title: 'Launch day ✨',
  privacyLevel: 'PUBLIC_TO_EVERYONE',
});

// Or upload the bytes directly.
await tiktok.publishVideo({
  videoFile: { data: await readFile('launch.mp4'), mimeType: 'video/mp4' },
  title: 'Launch day ✨',
});

// Photo carousel.
await tiktok.publishPhotos({
  photoUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
  title: 'Three ways to use it',
});
```

**Publishing is asynchronous.** `publishVideo` returns a `publishId`, not a
post — TikTok transcodes first. Poll for the result, or listen for the
`post.publish.complete` webhook:

```typescript
const status = await tiktok.getPublishStatus(publishId);
// { status: 'PUBLISH_COMPLETE', publiclyAvailablePostIds: ['7300…'] }
```

`getCreatorInfo()` returns what the creator is allowed to post right now —
TikTok requires querying it before showing a post UI, and it tells you which
privacy levels are available.

Two things bite first-timers here:

- **`privacy_level` defaults to `SELF_ONLY`** in this adapter. An unaudited app
  may only post privately; publishing publicly before the audit silently is not
  an option, so the safe default is the private one. Pass `privacyLevel`
  explicitly once your app is audited.
- **`PULL_FROM_URL` needs a verified domain.** Add the URL prefix under the
  app's URL properties, or the init call fails with `url_ownership_unverified`.

## Messaging

`send()` covers both messaging surfaces, chosen by `metadata.kind`:

```typescript
// Comment reply — public API, works out of the box.
await hub.send({
  channel: 'tiktok',
  to: { channelUserId: videoId },
  content: { type: 'text', text: 'Thanks! Link is in our bio.' },
  metadata: { kind: 'comment', videoId, commentId },
});

// Direct message — needs the directMessages config below.
await hub.send({
  channel: 'tiktok',
  to: { channelUserId: conversationId },
  content: { type: 'text', text: 'Shipping tomorrow!' },
  metadata: { kind: 'dm', conversationId },
});
```

`send()` is **text-only on both surfaces**, and the adapter's capabilities say
so — comments and DMs carry no media. Posting media goes through the publish
helpers above, outside `send()`, exactly as `publishPost()` does on the feed
adapters.

Inbound comments arrive with `metadata.videoId` and `metadata.commentId` already
set, so replying straight back to one needs no extra lookup:

```typescript
tiktok.onInbound(async ([message]) => {
  await tiktok.send({ ...reply, metadata: message.metadata });
});
```

### ⚠️ Direct messages need a partner endpoint

TikTok publishes **no DM API on the open developer platform**. Direct messaging
is exposed only through its business/partner messaging products, and the host
and auth differ per partner — so this adapter cannot ship a hardcoded URL for
it. Configure the endpoint you have been granted:

```typescript
createTikTokAdapter({
  // …credentials…
  directMessages: {
    baseUrl: 'https://business-api.tiktok.com/open_api/v1.3/im',
    sendPath: '/messages/send',   // default
    listPath: '/messages/list',   // optional — enables DM polling
    accessToken: process.env.TIKTOK_BUSINESS_TOKEN,   // defaults to the OAuth token
    headers: { 'X-Business-Id': process.env.TIKTOK_BUSINESS_ID! },
  },
});
```

Without this block, comment replies work normally and a DM send fails with
`tiktok_dm_not_configured` and an explanation — rather than accepting the
message and dropping it.

| Use | Supported |
| --- | --------- |
| Publish videos (direct post or inbox draft) | ✅ |
| Publish photo carousels | ✅ |
| Reply to comments on your videos | ✅ |
| Poll comments as inbound messages | ✅ |
| Send/receive DMs | ⚠️ Needs partner messaging access — see above |
| Unsolicited DM blasts | ❌ Not a TikTok product, and spam under its terms |

## Inbound

TikTok's own webhooks carry publish and authorization events, not messages, so
they go to `onEvent` and produce no inbound:

```typescript
tiktok.onEvent((event) => {
  if (event.event === 'post.publish.complete') console.log(event.content);
});
```

Comments have no webhook at all, so they are **polled** — `start()` polls every
video the adapter knows about (`watchVideoIds`, plus anything passed to
`watchVideo(id)`) on a timer. Pass a `stateStore` to persist the cursors so a
restart doesn't replay old comments. The first poll of an unseen video only
records the high-water mark; it deliberately emits nothing, since replaying a
video's entire comment history on boot is never what you want.

DMs behave the other way round: a first poll **does** deliver what it finds,
because a pending conversation is someone waiting on a reply. Persist the cursor
with a `stateStore` so a restart resumes instead of re-reading the window.

Signature verification follows TikTok's `TikTok-Signature: t=…,s=…` header —
HMAC-SHA256 over `"<t>.<raw body>"` keyed by the client secret. Pass the raw
bytes, not a re-serialized body. Requests signed more than
`webhookToleranceSec` ago (default 300) are rejected, which bounds replay of a
captured request.

## Errors

TikTok answers **HTTP 200 with `error.code: "ok"`** on success and a non-`ok`
code on failure, so the envelope — not the status — is the real result. The
adapter reads it that way, and marks `rate_limit_exceeded`,
`spam_risk_too_many_posts`, HTTP 429/5xx and network failures as retryable while
everything else (a revoked scope, a deleted video) is permanent. A non-2xx with
no envelope at all — a gateway 502, an empty 4xx — is treated as a failure
rather than an empty success, so a reply that never landed is never reported as
sent.

## License

MIT
