# @msgly/messenger

## 1.11.0

### Minor Changes

- 7360206: Chat links — the URL behind a "scan to message us" QR code, for every channel
  that has one.

  ```typescript
  const links = await hub.getChatLinks({ ref: "diwali-poster" });
  // [
  //   { channel: 'whatsapp',  url: 'https://wa.me/919876543210',              target: '+91 98765 43210', … },
  //   { channel: 'instagram', url: 'https://ig.me/m/acme?ref=diwali-poster',  target: 'acme', … },
  //   { channel: 'telegram',  url: 'https://t.me/acme_bot?start=diwali-poster', … },
  // ]
  ```

  **No QR dependency ships with this.** The library returns the URL and you render
  the image with whatever encoder you already use — the same string works as a
  plain link or a button. `hub.getChatLinks()` fans out over every registered
  channel; a single adapter throwing is caught and reported through the `'error'`
  event rather than sinking the batch. One adapter at a time is
  `adapter.getChatLink?.()`.

  **Two extras that are not universal, and say so rather than lying.**
  `options.text` prefills the first message; `options.ref` is a tracking payload
  handed back on the first inbound message, so you can tell which poster a
  conversation came from. Each returned link reports `prefilled` and `tracked` for
  what actually happened:

  - **WhatsApp** — `wa.me/<number>`. Prefill ✅
  - **Messenger / Instagram** — `m.me/<page>`, `ig.me/m/<handle>`. Ref ✅, as the `referral` event
  - **Telegram** — `t.me/<bot>`. Ref ✅, as `/start <ref>`
  - **LINE** — `line.me/R/ti/p/@<id>`
  - **Viber** — `viber://pa?chatURI=…`, plus `https://viber.me/…` for desktop. Prefill ✅
  - **WeChat** — a QR ticket, see below. Ref ✅, as the scene id
  - **Teams** — `teams.microsoft.com/l/chat/…`. Prefill ✅
  - **Slack** — `slack.com/app_redirect?app=…`
  - **Discord** — the bot install link
  - **Reddit** — `reddit.com/message/compose?to=…`. Prefill ✅
  - **Mattermost / Rocket.Chat** — your server's own DM URL
  - **Google Chat** — the Marketplace listing
  - **TikTok** — the profile URL
  - **SMS** (Twilio, Plivo, Vonage, Telnyx, Genesys) — `sms:<number>`. Prefill ✅
  - **Email** (all eight) — `mailto:<address>`. Prefill ✅

  Telegram's `start` parameter allows 64 characters of `A-Za-z0-9_-`, so a `ref`
  it would reject is dropped and `tracked: false` reported — better than emitting
  a link that fails to open.

  **Three channels are shaped differently, which is worth knowing before building
  the UI.** WeChat has no shareable URL at all: it mints the code server-side and
  returns a ticket, so the link carries **`qrImageUrl`** — display WeChat's own
  image rather than encoding anything. Discord has no "DM this bot" URL, since a
  bot is reachable only once it is in a server, so the link is the install one.
  Google Chat and TikTok point at a Marketplace listing and a profile because
  neither platform has a direct-message deep link.

  **Five channels need one config field**, because the handle is not derivable
  from the credentials: `appId` (Slack), `publicAccountUri` (Viber), `teamName`
  (Mattermost), `username` (TikTok), `marketplaceAppId` (Google Chat). Without it
  `getChatLink()` returns `null` and the channel is left out of `getChatLinks()`.
  WhatsApp resolves its number from the Graph API once and caches it, or takes
  `displayPhoneNumber` to skip the call; Messenger, Instagram, Telegram, LINE,
  Mattermost and Rocket.Chat resolve their handle the same way.

  **Channels with no such concept omit the method entirely** rather than returning
  null, so the result maps straight onto a list of QR codes with no filtering on
  your side — and TypeScript makes you guard `getChatLink?.()`. That covers push
  (APNs, FCM, Web Push, Expo), which delivers to a device token nobody can scan
  their way into; voice, which places calls rather than opens conversations; and
  msg91, exotel and rcs-twilio, whose alphanumeric sender ids and messaging
  service SIDs cannot receive a reply, making an `sms:` link a dead end.

  `@msgly/core` also exports **`withQuery(base, params)`**, the shared URL builder
  behind these links, so escaping is identical everywhere — a prefilled message
  full of spaces, `&` and emoji survives the round-trip unchanged.

- 7360206: Carry the sender's profile photo on inbound messages.

  `ContactRef` gains three optional fields — **`avatarUrl`**, **`username`** and
  **`email`** — so an inbox UI can show who is writing, not just an opaque id.
  All three are additive; nothing that reads `ContactRef` today changes.

  **Where the photo is in the webhook, it is now on the contact.** Discord sends
  an avatar _hash_ rather than a URL, so the adapter builds the CDN link and picks
  `.gif` for animated (`a_`-prefixed) hashes and `.png` otherwise. Viber and
  Google Chat carry a URL directly. Rocket.Chat's webhook has no avatar at all,
  but the server serves one per username at a stable path, so it is derived from
  `serverUrl`. `username` is filled wherever the payload already has a handle:
  Discord, Telegram, Mattermost, Rocket.Chat, TikTok and Reddit.

  **Meta puts none of it in the webhook** — Messenger and Instagram send only the
  PSID/IGSID. The photo is one Graph call away, which is how inbox tools show it,
  so both adapters can now fetch it: set **`fetchSenderProfile: true`** and every
  inbound message arrives with `displayName`, `avatarUrl` and, on Instagram,
  `username` filled in.

  It is off by default because it costs one Graph call per _sender_ on top of the
  webhook you already handle. Three things keep that honest:

  - **Cached per sender** (one hour, `senderProfileCacheTtlMs`), so a burst of
    messages from one person is a single call.
  - **A failed lookup never costs you the message.** Errors are swallowed and the
    fields left unset. A failure caches for only 60 s, so a blip does not blank
    the photo for an hour, while a sender who genuinely has no profile is not
    re-fetched on every message either.
  - **Unique senders only** per webhook batch, resolved in parallel.

  `adapter.getSenderProfile(id)` fetches one on demand for callers who would
  rather not pay it on every message. Note that Messenger splits the name across
  `first_name`/`last_name` (joined into one `displayName`) and has no handle at
  all, so `username` stays unset there — that field is Instagram-only.

  **Every email channel now sets `contact.email`.** The address was already the
  `channelUserId`, but setting the field explicitly means callers can read
  `contact.email` uniformly instead of knowing that on email channels the user id
  happens to be an address.

  Two things are deliberately absent. **WhatsApp exposes no end-user profile photo
  at any endpoint** — `contacts[].profile.name` is the whole of it — so there is
  nothing to opt into there. And channels that hide the photo behind a separate
  profile call (Slack `users.info`, Telegram `getUserProfilePhotos`, LINE
  `getProfile`) leave `avatarUrl` undefined rather than making an extra request
  per message; the sender id is in `metadata` if you want to fetch it yourself.

  Platform CDN avatar URLs are usually short-lived or access-controlled, so copy
  the image to your own storage if you need it to keep resolving.

### Patch Changes

- Updated dependencies [7360206]
- Updated dependencies [7360206]
  - @msgly/core@1.11.0

## 1.10.0

### Patch Changes

- Updated dependencies [18adeef]
  - @msgly/core@1.10.0

## 1.9.0

### Patch Changes

- Updated dependencies [90e48f6]
  - @msgly/core@1.9.0

## 1.8.0

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0

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
