# Inbound/outbound audit

One pass over every adapter's send path and webhook path, run September 2026
against `main` at v1.6.0. It started as a review of `@msgly/whatsapp` and was
repeated channel by channel with the same checklist, so the findings are
comparable across the library.

One file per channel. Each lists what was checked, what is wrong, and what is
already right — a finding is only written down if it was traced in the code,
and anything a pass did not cover is said so explicitly rather than left to
look like a clean bill of health.

## The checklist

Outbound

1. Is a failure classified — can the caller tell a dead recipient from a throttle?
2. Does the error `code` carry something the hub can act on?
3. Are failures that cannot change between attempts still retried?
4. Is the platform's own error detail preserved?
5. Is `recipientId` set, so a receipt can be reconciled?
6. Do declared `capabilities` match what `send()` actually does?
7. Are platform limits enforced, or left for the API to reject?
8. Is `replyTo` honoured where the platform has threading?
9. Is media (filename, multiple attachments) carried intact?

Inbound

10. Is the webhook signature verified, and what happens when it cannot be?
11. Is `externalId` set, so the hub can drop duplicate deliveries?
12. Are the bot's own messages filtered out, so a reply loop cannot form?
13. Is anything silently dropped — a second attachment, a status callback, a media message?
14. Are delivery receipts parsed, or discarded?

## Cross-cutting findings

These are not one channel's problem. Ranked by what they cost.

### 1. `permanent` is used to mean "not transient" — and suppresses live recipients

**reddit, tiktok, wechat, line, viber** · High

`permanent: true` tells a suppression store the address is dead
([suppression.ts:259](../../packages/core/src/suppression.ts:259)). Five adapters
set it from "is this error transient?", which is a different question, so
failures that say nothing about the recipient bin the recipient anyway:

- **wechat** — `permanent: data.errcode !== 45028 && data.errcode !== 45009`
  ([index.ts:611](../../packages/adapter-wechat/src/index.ts:611)). WeChat access
  tokens expire every two hours by design; errcode `40001` during that window
  marks every recipient you touch as permanently dead. So does `-1`, which is
  literally "system busy, try again later".
- **reddit** / **tiktok** — `permanent: true` on local validation errors like
  `reddit_unsupported_content` and `tiktok_unknown_kind`. Sending an image to a
  text-only channel suppresses the contact.
- **line** — `permanent: res.status >= 400 && res.status < 500 && res.status !== 429`
  ([index.ts:459](../../packages/adapter-line/src/index.ts:459)). A `401` from a
  rotated channel token suppresses whoever you were messaging at the time.
- **viber** — `permanent: true` on `viber_broadcast_limit` and
  `viber_unsupported_content`, both decided locally before any network call.

`@msgly/whatsapp` now splits the two questions: `permanent` for recipient-fatal
only, `retryable` for "could this ever work". The same split applies here.

### 2. Nearly every send failure is retried three times

**20 of 29 adapters** · Medium

`isRetryableError` looks for an HTTP status inside the error code
([hub.ts:216](../../packages/core/src/hub.ts:216)). Eight adapters put one there
— exotel, gmail, line, mattermost, msg91, plivo, sendgrid, telegram — two of
them by accident, since Google's `error.code` and Mattermost's `status_code`
happen to *be* the HTTP status. The other twenty embed the platform's own
application code: `discord_50007`, `twilio_21610`, `wechat_40001`, `meta_190`,
`smtp_550`. No status pattern matches any of those, so the hub retries a bad
token, a dead number and a missing template alike.

`@msgly/whatsapp` is the twenty-ninth: it now answers directly with
`error.retryable` instead of hoping the code parses.

### 3. Local validation failures are retried too

**44 distinct error codes** · Medium

Every `*_unsupported_content`, `*_missing_*`, `*_media_url_required`,
`*_limit` receipt describes something decided before the network was touched.
None set `retryable: false`, so each costs three passes through the hub's
backoff before surfacing.

### 4. No adapter honours `Retry-After`

**all 29** · Medium

Nothing in `packages/*/src` reads `Retry-After`, Discord's `retry_after`,
Telegram's `parameters.retry_after` or Slack's header. A 429 is retried on the
hub's own 500ms/1s/2s schedule, which for Slack (30s) or Discord (often longer)
lands inside the same window and deepens the throttle.

### 5. SMS delivery receipts are collected and thrown away

**twilio-sms, vonage-sms, telnyx, plivo, msg91, exotel** · Medium

Each has a `statusCallbackUrl` (or equivalent) in its config, and
`handleWebhook` recognises a status callback — in order to `return []`.
`mapPlivoStatus` is exported and never called by anything
([plivo/index.ts:113](../../packages/adapter-plivo/src/index.ts:113)). For SMS
this is where failure actually lives: the API accepts almost everything and the
carrier rejects later. Only `@msgly/whatsapp` and `@msgly/twilio-voice` expose a
`parseStatuses`.

### 6. `replyTo` is dropped by 25 of 29 adapters

**Medium**

Core documents it as safe to set anywhere, ignored only where the channel has no
threading concept ([types.ts:284](../../packages/core/src/types.ts:284)). Exactly
four adapters read it: discord, slack, telegram, whatsapp.

The rest silently drop it, and most of them *do* have threading — they just
reach it through a per-adapter `metadata` key instead: Teams (`replyToId`),
Mattermost (`root_id`), Rocket.Chat (`tmid`), Google Chat (`thread.name`),
Messenger/Instagram (`reply_to.mid`), LINE (a reply token, a different concept
again), and all five email adapters, which thread off `metadata.messageId` into
`In-Reply-To`. So the documented cross-channel field works on four channels and
every other channel has its own spelling.

### 7. Unauthenticated webhooks are accepted when no secret is configured

**exotel, googlechat, mattermost, msg91, plivo, resend, rocketchat, telegram, telnyx, twilio-sms, vonage-sms, sendgrid** · Medium

Each returns `true` from `verifySignature` when its secret/URL/key is unset.
`@msgly/twilio-voice` was changed in this same release to reject instead unless
`allowUnsignedWebhooks: true` is set; the rest still fail open silently.

**reddit** and **smtp** are the sharper case: `verifySignature` returns `true`
unconditionally and `handleWebhook` triggers a *poll*
([reddit/index.ts](../../packages/adapter-reddit/src/index.ts),
[smtp/index.ts](../../packages/adapter-smtp/src/index.ts)). Anyone who finds the
endpoint can drive your Reddit API quota — 100 queries/minute, enforced hard —
or your IMAP connection, from an unauthenticated request.

### 8. Four inbound paths set no `externalId`, so the hub cannot dedupe them

**line, messenger, instagram, sendgrid** · Medium

The hub drops a repeat delivery by `externalId`
([hub.ts:412](../../packages/core/src/hub.ts:412)). Missing on LINE postbacks,
Meta postbacks (both channels) and SendGrid Inbound Parse — all of which are
re-delivered by the platform when your endpoint is slow or errors. LINE even
sends `deliveryContext.isRedelivery` and a `webhookEventId`, both unread.

### 9. Meta adapters put the page access token in the URL

**messenger, instagram** · Medium

`${sendUrl()}?access_token=${...}`
([meta-base.ts](../../packages/adapter-messenger/src/meta-base.ts)). Query strings
land in proxy logs, CDN logs and browser-style request logs; the Graph API
accepts the same token in an `Authorization` header, which is what
`@msgly/whatsapp` does.

### 10. Both Meta channels report errors as `meta_*`

**messenger, instagram** · Low

Every other adapter namespaces by channel. These two share `meta-base.ts` and
emit `meta_190` from both, so a receipt cannot say which channel produced it.

### 11. Media filenames do not survive

**telegram, discord, slack, msteams, googlechat, messenger, instagram, wechat** · Low

`MediaReference.filename` exists for this and is never read on the way out, nor
populated on the way in. Teams is the odd one: it puts `content.caption` in the
attachment's `name` field, so a caption becomes the filename
([msteams/index.ts:380](../../packages/adapter-msteams/src/index.ts:380)).
Handled correctly by line, mattermost, rocketchat, viber, whatsapp and the email
adapters.

### 12. `location` cannot be declined

**core** · Low

`assertSupported` hardcodes `location: true`
([hub.ts](../../packages/core/src/hub.ts)), so `AdapterCapabilities` cannot say
"this channel has no location message". Every SMS and email adapter re-rejects
it by hand in `send()`.

## Per channel

| Channel | High | Medium | Low | Notes |
|---|---|---|---|---|
| [whatsapp](whatsapp.md) | — | — | 2 | audited first; every finding fixed in v1.7.0 |
| [telegram](telegram.md) | 1 | 4 | 2 | a blocked bot is invisible on both paths |
| [slack](slack.md) | — | 4 | 1 | one error code for every failure |
| [discord](discord.md) | — | 4 | 2 | interaction-token expiry unhandled |
| [line](line.md) | 1 | 3 | 2 | a 401 suppresses the recipient |
| [wechat](wechat.md) | 2 | 3 | 1 | token expiry suppresses the audience |
| [messenger](messenger.md) | — | 5 | 2 | page token in the URL; shared base |
| [instagram](instagram.md) | — | 5 | 2 | page token in the URL; shared base |
| [msteams](msteams.md) | 1 | 3 | 1 | attachment dropped when text is present |
| [mattermost](mattermost.md) | 1 | 2 | 1 | interactive buttons are inert |
| [rocketchat](rocketchat.md) | — | 3 | 1 | room-gone never suppresses |
| [googlechat](googlechat.md) | — | 3 | 2 | inbound attachments ignored |
| [viber](viber.md) | — | 4 | 1 | `size: 0` on file and video sends |
| [twilio-sms](twilio-sms.md) | 2 | 3 | 1 | a STOP reply never suppresses |
| [twilio-voice](twilio-voice.md) | — | 2 | 1 | mostly fixed in v1.7.0 |
| [vonage-sms](vonage-sms.md) | 1 | 3 | 1 | multipart SMS reported on part 1 |
| [telnyx](telnyx.md) | — | 3 | 1 | delivery events dropped |
| [plivo](plivo.md) | — | 3 | 1 | status mapper exported, never called |
| [msg91](msg91.md) | — | 3 | 1 | failures coded `msg91_200` |
| [exotel](exotel.md) | — | 3 | 1 | delivery callbacks dropped |
| [gmail](gmail.md) | 1 | 3 | 1 | history cursor advances before use |
| [outlook](outlook.md) | — | 4 | 1 | Graph error strings defeat retry check |
| [smtp](smtp.md) | 1 | 3 | 1 | SMTP 5xx never suppresses |
| [ses](ses.md) | — | 2 | 1 | best bounce handling in the library |
| [sendgrid](sendgrid.md) | — | 3 | 1 | Inbound Parse cannot be deduplicated |
| [resend](resend.md) | — | 3 | 1 | bounces classified, send failures not |
| [fcm](fcm.md) | — | 2 | 1 | `INVALID_ARGUMENT` over-suppresses |
| [reddit](reddit.md) | 2 | 2 | 1 | open endpoint drives the poller |
| [tiktok](tiktok.md) | 1 | 3 | 1 | validation errors suppress |
| **total** | **14** | **88** | **36** | |
Counts are findings recorded in each file, not a quality score — a small adapter
has less to get wrong.
