# @msgly/core

## 1.8.0

### Minor Changes

- 79a2749: Add Mailgun, Postmark and Exotel Voice.

  **`@msgly/mailgun`** covers sending, inbound routes and signed event webhooks.
  Mailgun already draws the distinction email actually needs, in its `severity`
  field: a `permanent` failure is a dead mailbox, a `temporary` one is a full
  inbox or a greylist. That maps straight onto core's `permanent`, so bounces
  suppress and deferrals do not.

  Two details that cost people an hour each are handled explicitly. Mailgun keeps
  EU-region domains on a different host, and pointing at the wrong one returns a
  404 that reads exactly like a missing domain — `region: 'eu'` switches it, and
  `verifyCredentials` names the possibility when a lookup 404s. And the webhook
  signing key is a _different_ value from the API key; using one for the other
  produces a verification that silently never matches.

  Inbound attachments stay lazy: the message carries Mailgun's storage URL and the
  bytes are only fetched when `downloadMedia` is called, which keeps a mailbox full
  of large attachments from becoming a memory problem. Inline images go on
  Mailgun's `inline` field rather than `attachment`, which is what makes `cid:`
  references resolve in an HTML body.

  **`@msgly/postmark`** covers sending, inbound parsing and bounce webhooks.

  Postmark answers **HTTP 200 with a non-zero `ErrorCode`** on failure, so the
  adapter reads the code rather than trusting the status line. `406` is the one
  worth knowing: Postmark already has that address suppressed from an earlier hard
  bounce and refused to send — reported as recipient-fatal, so your list agrees
  with theirs instead of retrying forever. Message streams are first-class,
  because Postmark refuses a send on the wrong one and campaigns down the
  transactional stream get accounts reviewed.

  Postmark does not sign webhooks at all, so a URL token is the only guard short
  of IP allow-listing. With none configured `verifySignature` rejects rather than
  accepting whatever arrives: an unverified bounce webhook is a way for anyone to
  get your recipients suppressed.

  **`@msgly/exotel-voice`** is deliberately narrower than the other three voice
  adapters, because the platform is.

  Twilio, Plivo and Vonage all let you return TwiML, Plivo XML or an NCCO from a
  webhook and have the caller hear it. Exotel does not — what a caller hears comes
  from an App Bazaar flow built in the dashboard, and the API places and bridges
  calls into it. So this adapter declares `text: false` and no media, rather than
  claiming a capability `send()` could never honour. What it does offer is what
  Exotel is genuinely good at: `connectNumbers()` for click-to-call (the Indian
  marketplace pattern of connecting two people without either seeing the other's
  number), `connectToFlow()` for IVR dialling, inbound Gather webhooks, and
  `parseStatuses()` for outcomes. `send()` maps to flow dialling, and without a
  flow id it fails with a message pointing at `connectNumbers()` rather than
  failing vaguely.

  Across all three voice adapters the permanence rule is the same: only a genuinely
  failed call marks the number recipient-fatal. Busy and no-answer are the person,
  not the line.

  `@msgly/core` registers `mailgun`, `postmark` and `exotel-voice` in
  `KnownChannel` and the per-channel rate-limit table.

- 79a2749: Add Expo push and RCS Business Messaging, and a `card` content type in core.

  **`@msgly/expo-push`** covers React Native apps shipped through EAS, where Expo
  holds the platform credentials so you never touch a `.p8` file or a service
  account.

  The part Expo integrations usually get wrong is that a send returns a _ticket_,
  not a delivery — and a completely dead token still comes back `status: ok`. So
  the receipt says `queued` rather than `sent`, and `getReceipts()` is what
  actually tells you what happened. `DeviceNotRegistered` only ever appears in a
  receipt, never in a ticket, which means skipping that call leaves a token list
  that never cleans itself. `sendMulticast()` batches up to 100 per request and
  maps tickets back to tokens positionally, failing explicitly rather than
  shifting every result onto the wrong token if Expo returns a short array.

  **`@msgly/rcs-twilio`** sends the branded, verified rich messaging Google
  Messages renders — cards, images and suggestion chips — with automatic SMS
  fallback.

  RCS is not SMS, however often the two get conflated: SMS has no markup and no
  buttons, and there is nowhere to put one. What it shares with SMS here is
  Twilio's `/Messages.json` endpoint. The sender is chosen by
  `MessagingServiceSid` rather than a from-number, which is how Twilio decides
  per-recipient whether the handset can take RCS and falls back through the rest
  of the pool when it cannot.

  Twilio needs a `ContentSid` for anything richer than plain text, and unlike
  WhatsApp's, RCS content templates need no approval — so the adapter creates one
  on demand and caches it by a hash of the rendered template. The same card sent a
  thousand times creates one template. `autoCreateTemplates: false` hands that
  back to you via `metadata.contentSid`. Plain text never creates a template at
  all.

  Every rich type ships a `twilio/text` alongside it, because that is what a
  fallback to SMS actually delivers — without it the fallback arrives blank. For a
  `cta_url` the fallback keeps the URL in the body, since an SMS has no button to
  hang it on.

  `21610` — the recipient replied STOP — is marked recipient-fatal so a
  suppression store acts on it. That one is not merely a delivery optimisation. A
  wrong Messaging Service SID is equally unretryable but suppresses nobody, since
  it says nothing about the person on the other end. Send failures and status
  callbacks share one `rcs_twilio_<code>` namespace, so a single check covers both
  paths, and `parseStatuses` surfaces the `delivered` and `read` states RCS has
  and SMS does not.

  Unverifiable webhooks are refused unless `allowUnsignedWebhooks` is set, matching
  the change `@msgly/twilio-voice` made in this release.

  **`@msgly/core`** gains `CardContent` — media, title, body and a mix of reply,
  URL and dial actions in one message. That is the shape branded business
  messaging actually sends, and nothing in the existing union expressed it:
  `CtaUrlContent` covers text plus one link, but its header is text-only, so there
  was no way to say "the picture is the point". Adapters opt in with
  `capabilities.interactive.cards`, and the hub throws `UnsupportedFeature`
  elsewhere rather than silently flattening a card into a paragraph.

  Also registers `expo-push` and `rcs-twilio` in `KnownChannel` and the
  per-channel rate-limit table.

- 79a2749: Add two push channels, so push is a complete story rather than one provider.

  **`@msgly/apns`** talks to Apple directly. Until now the only way to reach an
  iPhone through this library was FCM, which means running every iOS notification
  through Firebase — an extra vendor, an extra account, and an extra place for a
  token to go stale.

  Auth is a provider token: an ES256 JWT signed with a `.p8` key. Apple accepts
  one for an hour but refuses regeneration more than once every twenty minutes, so
  the token is cached with both bounds in mind rather than minted per send.

  The awkward part is transport. APNs speaks HTTP/2 only and `fetch` cannot —
  Node's fetch is undici over HTTP/1.1, which throws when handed APNs' binary
  frames. Every other adapter here is pure `fetch` and runs anywhere; this one
  defaults to a transport built on `node:http2`, with `config.transport` as the
  seam for other runtimes. The test suite uses that same seam, so no test opens a
  real connection.

  Dead tokens are separated from bad requests, because they call for different
  handling: `Unregistered`, `BadDeviceToken` and `DeviceTokenNotForTopic` are
  recipient-fatal and suppress; `ExpiredProviderToken` and `PayloadTooLarge` are
  permanently unretryable and suppress nobody — marking those `permanent` would
  bin every device touched while a key was stale. `Unregistered` carries Apple's
  timestamp saying when the token died, which the error message now includes: if
  the device registered a newer token after that moment, the new one is still good.

  Message ids are UUIDs, which is the format `apns-id` wants, so the adapter sends
  the message id as `apns-id` and a retried send is the same notification rather
  than a second one on someone's lock screen.

  `sendRaw()` covers what the content model does not — silent background
  refreshes, VoIP, Live Activities, critical alerts — with full control of the
  headers.

  **`@msgly/web-push`** is browser notifications with no vendor at all: VAPID for
  identity, `aes128gcm` for payloads, straight to whatever push service the
  browser uses.

  Payloads are encrypted end-to-end for a single subscription, so the push service
  relays bytes it cannot read. There is no plaintext mode in the spec and none
  here. The implementation is verified rather than assumed: the test suite
  decrypts its own output with the subscription's private key and asserts the
  plaintext, which is the only way to know a `aes128gcm` implementation is right
  instead of merely well-shaped.

  A subscription is passed as `contact.channelUserId` — the browser's
  `PushSubscription` JSON, endpoint and keys together, so it survives `sendBulk`
  as one opaque value. Passing the endpoint with the keys in `metadata` also
  works.

  `404` and `410` mean the subscription is gone and suppress; a rejected VAPID
  token or an oversized payload is unretryable but says nothing about the
  subscriber. On a `429` the service's `Retry-After` is appended to the error
  message, since a receipt has nowhere better to carry it.

  Both channels are one-way. `handleWebhook` returns nothing and
  `capabilities.interactive.buttons` is `false` on both — a Web Push notification's
  action buttons reach your service worker, not your server, and saying otherwise
  would be the kind of capability claim that fails at runtime.

  `@msgly/core` gains `apns` and `web-push` in `KnownChannel` and in the
  per-channel rate-limit table.

- 79a2749: Add Plivo Voice and Vonage Voice, taking voice from one provider to three.

  Both follow the request/response model `@msgly/twilio-voice` was rewritten to
  use in this release, because a phone call genuinely is request/response: the
  provider holds the HTTP request open and speaks whatever comes back. That reply
  cannot come from the hub's `on('message')` handler, which runs _after_ the
  response has already been sent. So both take a `respond(message)` hook that
  produces the answer inside the webhook request, with no shared state — and both
  are deliberately synchronous, since an `await` there is dead air on the line.

  **`@msgly/plivo-voice`** speaks Plivo XML and reuses the Auth ID and Token from
  `@msgly/plivo`, so one set of credentials covers SMS and voice. Text is
  XML-escaped, which matters more than it sounds: an ampersand in a customer's
  name would otherwise break the whole document. Plivo redirects a live call to a
  URL rather than accepting XML inline, so `send()` needs `metadata.transferUrl`
  and says so in the error rather than failing vaguely.

  Webhook verification uses Plivo's V3 scheme and accepts the several
  comma-separated signatures sent during key rotation. Without a `webhookUrl`
  there is nothing to verify, so it rejects rather than accepting blindly —
  `allowUnsignedWebhooks` is the explicit opt-out, matching Twilio Voice.

  **`@msgly/vonage-voice`** speaks NCCO and authenticates with a signed
  application JWT — an Application ID plus a private key, _not_ the
  api_key/api_secret pair `@msgly/vonage-sms` uses. Two separate credentials on
  one account, and mixing them up is the first thing that goes wrong, so
  `verifyCredentials` names the distinction directly. Each JWT carries its own
  `jti` because Vonage rejects a replayed token.

  Vonage accepts a transfer NCCO inline, so `send()` redirects a live call with no
  extra endpoint to host.

  It does not pretend to verify webhooks: Vonage signs voice callbacks only when
  the application is configured for it, over a JWT in the `Authorization` header
  rather than the body. `verifySignature` returns `true` and the README says
  plainly that this means unverified, rather than implying a check that is not
  happening.

  Both map `interactive` content to keypad digits — a phone has no screen, so each
  button becomes the digit at its position and the prompt reads them out — and
  both expose `parseStatuses`, where the permanence rule is the one that matters:
  only a failed or rejected call marks the number recipient-fatal. Busy and
  no-answer are the _person_, not the line. They may answer next time, and
  suppressing there quietly deletes a live customer.

  `@msgly/core` registers both in `KnownChannel` and the rate-limit table, at a
  deliberately low rate: a call holds a line for its whole duration, so throughput
  is bounded by concurrent channels rather than requests per second.

- 79a2749: Fix WhatsApp send-failure handling, which retried failures that could never
  succeed and could not tell a dead number from a throttle.

  **Every failed send was retried three times.** The hub decides retryability by
  looking for an HTTP status inside `error.code`, but WhatsApp answers almost
  everything with HTTP 400 and puts the real cause in `error.code` as its own
  application code. So `wa_190` (access token expired), `wa_100` (invalid
  parameter), `wa_132001` (template does not exist) and `wa_131026` (not a
  WhatsApp user) all sailed past the check and were retried with backoff, burning
  the retry budget and the API quota to arrive at the same failure. The adapter
  now classifies Meta's codes itself, and the core honours that verdict.

  **Failures carried no `permanent` flag**, so suppression stores could never act
  on them: a number that is not on WhatsApp looked exactly like a rate limit and
  stayed in every future campaign.

  The two questions turn out to be different ones, and conflating them is how you
  suppress a whole contact list over a typo in a template name. `DeliveryReceipt.error`
  now has both:

  - `permanent` — is this _recipient_ dead? Set only for `131021` and `131026`.
    This is what suppression reads.
  - `retryable` — could the same request ever succeed? `false` for bad tokens,
    bad parameters, unknown or paused templates, a closed 24-hour window; `true`
    for throttles and Meta-side outages.

  Unrecognised codes leave both `undefined`, which the core reads as "retry, never
  suppress" — wrongly binning a reachable customer is worse than a wasted retry.
  `isRetryableError` consults the adapter's verdict first and falls back to its
  old status-sniffing heuristic only when an adapter says nothing, so no other
  adapter changes behaviour.

  **A failed send and a failed status webhook reported the same Meta error under
  two different codes** — `wa_131026` from `send()`, `131026` from
  `parseStatuses()`. Both now use the prefixed form, so one check covers both
  paths.

  **Meta's error detail was dropped.** `error.message` is usually generic
  (`(#132012) Parameter format does not match format in template`); the sentence
  that says what is actually wrong lives in `error_data.details`. It is now
  appended to the message.

  **Documents lost their filename.** The outbound payload never set `filename`, so
  recipients saw a name derived from the URL — `9f2c` rather than
  `invoice-0042.pdf`. `uploadMedia` also dropped it from the ref it returned, and
  inbound documents never parsed it, so there was no way to round-trip a name.
  Fixed in all three places.

  Also: send receipts now set `recipientId` (the webhook path already did); list
  messages enforce Meta's cap of 10 rows across all sections, filling sections in
  order and dropping any left empty, instead of letting the API reject the whole
  message; and `header`/`footer` are truncated to 60 characters like every other
  label. Body text and row/button `id`s are deliberately left alone — truncating a
  body loses your message, and truncating an `id` silently breaks postback
  matching.

## 1.7.0

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

## 1.5.0

### Minor Changes

- 1d98daa: Add `@msgly/tiktok` — video and photo publishing, comment replies and direct messages.

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

## 1.4.0

### Minor Changes

- 27fa311: Add `@msgly/reddit` — subreddit publishing, thread replies and inbox polling.

  Scope is deliberate. The adapter publishes posts and _replies_ to threads and
  messages that already exist, and ships **no bulk-DM helper**: unsolicited mass
  DMs are spam under Reddit's content policy and get accounts shadowbanned, often
  within one campaign. `send()` requires `metadata.thingId` naming what is being
  replied to, and failing that returns an error explaining why and pointing at
  `publishPost()` instead.

  Handles the Reddit-specific traps: it returns **HTTP 200 with a populated
  `errors` array** rather than an error status, so the array is treated as the
  real result, and `RATELIMIT` is marked retryable while a locked thread is
  permanent. The required descriptive `User-Agent` is enforced by
  `verifyCredentials`, since Reddit throttles generic agents.

  Reddit has no webhooks, so inbound is polled from the unread inbox with a
  persistable cursor — the same model as the SMTP/IMAP adapter. Replies address
  the _thing_ fullname rather than the username, because that is what
  `/api/comment` expects back.

## 1.3.0

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

## 1.2.0

### Minor Changes

- 7bae280: Add `@msgly/ses` and `@msgly/fcm`.

  **Amazon SES** — the missing piece for high-volume campaign email, roughly 10×
  cheaper than transactional providers at scale. AWS SigV4 signing is implemented
  on Web Crypto, so there is no AWS SDK dependency and the adapter stays
  Edge-compatible. SES's SNS notifications carry an explicit
  `bounceType: Permanent | Transient`, which is the cleanest hard/soft signal of
  any adapter here and maps straight onto the suppression store — important,
  because SES suspends accounts over ~5% bounces or ~0.1% complaints.
  `verifyCredentials` also surfaces the sandbox state, whose failure mode is a
  campaign silently reaching almost nobody. Attachments and custom headers switch
  the send to raw MIME automatically, since SES's `Simple` shape supports neither.

  Note SNS signature verification is deliberately partial: the adapter validates
  that the signing certificate URL is genuinely AWS-hosted — blocking the forged
  bounce attack — but does not verify the RSA signature, which needs X.509
  parsing Web Crypto does not provide. The README states this plainly rather than
  implying full verification.

  **FCM** — push notifications for Android, iOS and web, opening a channel
  category the library did not cover. Two-legged service-account auth with a
  cached token. Dead tokens (`UNREGISTERED`, `SENDER_ID_MISMATCH`) are marked
  permanent so an uninstalled app stops consuming quota, read from
  `error.details[].errorCode` rather than the generic top-level status.
  `sendToTopic` covers true broadcast, which is far cheaper than looping over
  device tokens.

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

- 8f5aa23: Suppress recipients automatically on hard bounces and spam complaints.

  `DeliveryReceipt.error` gains `permanent` and `complaint` flags, and
  `applyDeliveryReceipt(receipt, channel, store)` feeds them into the suppression
  store so a campaign list cleans itself:

  ```ts
  hub.on("delivery", (r) => applyDeliveryReceipt(r, "resend", suppression));
  ```

  The classification is the point. **Only permanent failures suppress** — a
  deferral, a full mailbox, or a temporary block leaves the address alone, and an
  unclassifiable failure suppresses nothing, since wrongly dropping a deliverable
  address is worse than a wasted retry.

  Resend marks `email.bounced` and `email.complained` permanent while leaving
  `email.delivery_delayed` transient. SendGrid needs more care: it reports hard
  bounces and temporary blocks through the _same_ `bounce` event, separated only
  by a `type` field, so `type: 'blocked'`, `deferred`, and `blocked` are treated
  as transient while `bounce`, `dropped`, and `spamreport` are permanent.

- 1abb35e: Add `@msgly/exotel` — SMS for the Indian market.

  Sends via Exotel's REST API and receives inbound SMS from its callback, with
  first-class DLT support (`dltEntityId` / `dltTemplateId`, overridable per
  message so one campaign can span several registered templates) and
  transactional vs. promotional routing.

  Exotel does not sign its webhooks, so the adapter supports a `webhookToken`
  shared secret checked in constant time against `?token=…`. Without it any caller
  that reaches your endpoint can forge inbound SMS — the README says so plainly.

  `verifyCredentials` distinguishes a bad key/token from an account that lives on
  the other regional cluster, which otherwise surfaces as a confusing 404.

- cacc6be: Add `@msgly/msg91` — India SMS via MSG91's DLT Flow API.

  Unlike the other SMS adapters this one declares `templates: true`, because
  MSG91's v5 API is template-first: DLT regulation forbids arbitrary text.
  `TemplateContent` names a registered template directly, while `TextContent` is
  injected into a configurable variable of `defaultTemplateId`, overridable per
  message via `metadata.templateId`. Sending text with no template resolved fails
  with an actionable error before spending an API call.

  Handles two MSG91 quirks that otherwise cause silent misreporting: a failed send
  returns `type: 'error'` on HTTP 200, and an invalid auth key returns an error
  string on HTTP 200. Phone numbers are normalised to the bare digits MSG91
  expects. Inbound parsing accepts the several field spellings MSG91 uses across
  its product lines, and `webhookToken` guards the unsigned webhook.

- e919523: Add `@msgly/plivo` and `@msgly/resend`.

  **Plivo** — global SMS and MMS with V3 webhook signature verification
  (`base64(HMAC-SHA256(authToken, url + nonce))`), accepting multiple
  comma-separated signatures so key rotation doesn't cause an outage. Because
  Plivo signs the URL, `webhookUrl` must match exactly, and the README says so.
  MMS with a non-URL media reference fails fast rather than being rejected by the
  API, since Plivo has no upload endpoint.

  **Resend** — transactional email over HTTP, so unlike `@msgly/smtp` it is
  Edge-compatible. Verifies Svix-signed webhooks including a timestamp window that
  bounds replay. Delivery events (`email.sent`/`delivered`/`bounced`/…) are
  deliberately kept out of `handleWebhook` and exposed via `parseDeliveryEvent`
  instead, so status updates don't pollute the inbound message handler.
  `verifyCredentials` checks that the sending domain is registered _and verified_,
  which is the usual cause of a confusing first-send 422.

- d0aefc7: Require Node 20 or newer.

  The packages previously declared `engines: node >=18`, but that was never true:
  `globalThis.crypto` is not defined in Node 18 (it only became a default global
  in Node 19), and **17 of the 26 packages need it** for webhook signature
  verification. On Node 18 those adapters either threw or — worse, in the ones
  that fail closed — silently returned "signature invalid" for perfectly valid
  requests.

  CI now tests Node 20, 22 and 24. Node 18 reached end of life in April 2025.

  If you are on Node 18, upgrade. There is no workaround short of running with
  `--experimental-global-webcrypto`, which is not something a library should
  require of its users.

- 3aa2fdc: Add `@msgly/rocketchat` and `@msgly/googlechat`.

  **Rocket.Chat** — self-hosted team chat over the v1 REST API, authenticated with
  the `X-Auth-Token`/`X-User-Id` pair Rocket.Chat requires. Errors often arrive as
  HTTP 200 with `success: false`, so the flag is treated as the real result rather
  than reporting rejected messages as sent. Unsigned outgoing webhooks are guarded
  by a constant-time token check, and `bot`-marked posts are dropped to avoid a
  reply loop. The room is the addressable id; replies thread via `tmid`.

  **Google Chat** — two-legged service-account auth: an RS256 JWT assertion is
  signed with Web Crypto and exchanged for a cached OAuth token, with concurrent
  refreshes collapsed. Inbound requests carry a Google-signed bearer JWT, verified
  against Google's JWKS with `iss`/`aud`/`exp`/`nbf` checked and `alg` pinned to
  RS256 so algorithm-confusion attempts fail. Inbound text prefers `argumentText`
  (the @mention stripped), `CARD_CLICKED` events surface as interactions, and
  threaded replies set `messageReplyOption` — without it a reply silently starts a
  new thread.

- 20e7146: Add `@msgly/smtp` — an SMTP + IMAP adapter covering Yahoo, Zoho, Fastmail,
  iCloud, AOL, and any custom mail server.

  Sends via SMTP (plain-text or HTML bodies, threaded replies, optional
  attachments) and receives via IMAP polling with a persistable UID cursor so
  restarts resume where they left off. Omit the `imap` config for a send-only
  adapter.

  This package is **Node-only** — SMTP and IMAP are raw TCP/TLS protocols that
  `fetch` cannot speak, so unlike the other adapters it does not run on Edge or in
  a browser. It depends on `nodemailer` and `imapflow`.

  Core's `ChannelName` is now open (`KnownChannel | (string & {})`), so
  third-party adapters can define their own channel without a core release.
  Built-in channel names keep autocomplete.

- 0b22265: Add opt-out handling to campaigns.

  `sendBulk` previously sent to every recipient unconditionally, with no way to
  honour an opt-out. Honouring opt-outs is a legal requirement — TCPA and
  TRAI/DLT for SMS, CAN-SPAM and GDPR for email — so this closes a real gap
  rather than adding a convenience.

  - **`SuppressionStore`** — consulted before each send. Suppressed recipients are
    reported as a new `skipped` result rather than `failed`, because nothing went
    wrong and retrying them would be the violation. In-memory and KV-backed
    implementations ship with core; set it once via
    `createHub({ suppressionStore })` or per call. Pass `suppression: false` to
    bypass for genuinely transactional sends.
  - The check runs **before** a rate-limit token is taken, so suppressed
    recipients cost no campaign throughput, and it **fails closed** — if the store
    is unreachable the send is skipped and reported as failed, since not sending
    is the recoverable mistake.
  - **`detectConsentIntent` / `applyConsentIntent`** — recognise STOP, UNSUBSCRIBE,
    CANCEL and their non-English equivalents (plus START to resubscribe) and apply
    them to the store. Matching is whole-message only, so "please stop sending the
    weekly digest" is not treated as a global opt-out.
  - **`List-Unsubscribe` / `List-Unsubscribe-Post`** on the SMTP, Resend and
    SendGrid adapters via a new `unsubscribe` config, overridable per message for
    per-recipient tokens. Gmail and Yahoo have required these from bulk senders
    since February 2024. `List-Unsubscribe-Post` is emitted only when a URL is
    present, since one-click is an HTTP mechanism.

- c89d542: Add `@msgly/telnyx` and `@msgly/sendgrid`.

  **Telnyx** — global SMS/MMS verified with Ed25519 over `"{timestamp}|{body}"`,
  plus a timestamp window bounding replay. Verification fails closed when the
  runtime's Web Crypto lacks Ed25519, rather than silently accepting unverified
  webhooks.

  **SendGrid** — transactional email over HTTP, Edge-compatible. Handles the two
  differently-secured webhooks explicitly: the unsigned Inbound Parse endpoint is
  guarded by a URL token and produces messages, while the ECDSA-signed Event
  Webhook produces receipts via `parseDeliveryEvents`. The ECDSA signature is
  DER-encoded and is converted to the P1363 form Web Crypto requires — passing DER
  straight through fails every time. Reads the message id from the `X-Message-Id`
  header, since `/v3/mail/send` returns 202 with an empty body, and
  `verifyCredentials` confirms the key actually carries the `mail.send` scope.

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

- 1abb35e: Add `@msgly/vonage-sms` — global SMS via Vonage (Nexmo).

  Correctly treats Vonage's per-message `status` code as the result rather than
  the HTTP status, which is always 200 even for rejected messages, and translates
  the common failure codes into readable explanations. Non-GSM-7 text is
  automatically sent as `unicode` so emoji and non-Latin scripts are not mangled.

  Supports signed webhooks: pass `signatureSecret` and the adapter verifies the
  HMAC over sorted parameters in constant time. The legacy `md5hash` scheme is
  explicitly rejected with guidance rather than silently accepting unverified
  requests, since Web Crypto has no MD5.

### Patch Changes

- 20e7146: Add the missing root ESLint configuration. `pnpm lint` failed in every package
  with "ESLint couldn't find a configuration file", so the lint script had never
  actually run. Enabling it surfaced two unused imports, now removed.
- dd8ce7d: Repository and packaging fixes.

  - **Add the MIT LICENSE.** Every package declared `"license": "MIT"` with no
    licence text anywhere in the repo. The file is now present and, critically,
    listed in each package's `files` array so it actually ships in the published
    tarball rather than only living in git.
  - **Declare `engines: node >=18` on every package.** Only `@msgly/smtp` did.
    Every adapter needs `fetch` and Web Crypto, so a Node 16 user previously got
    a confusing runtime crash instead of an install-time warning.
  - **Add CI.** The README has always shown a CI badge pointing at
    `.github/workflows/ci.yml`, which did not exist — nothing verified the test
    suite on a pull request. The workflow builds, typechecks, lints and tests
    across Node 18/20/22, and a second job verifies all 26 packages actually pack
    with `dist/`, `README.md` and `LICENSE` before any release is attempted.
  - **Remove the stale `package-lock.json`.** This is a pnpm workspace; the npm
    lockfile caused wrong installs, and it is now gitignored.
  - Add the missing `@msgly/twilio-sms` and `@msgly/twilio-voice` READMEs, so all
    26 packages document themselves.

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

- 8f5aa23: Suppress recipients automatically on hard bounces and spam complaints.

  `DeliveryReceipt.error` gains `permanent` and `complaint` flags, and
  `applyDeliveryReceipt(receipt, channel, store)` feeds them into the suppression
  store so a campaign list cleans itself:

  ```ts
  hub.on("delivery", (r) => applyDeliveryReceipt(r, "resend", suppression));
  ```

  The classification is the point. **Only permanent failures suppress** — a
  deferral, a full mailbox, or a temporary block leaves the address alone, and an
  unclassifiable failure suppresses nothing, since wrongly dropping a deliverable
  address is worse than a wasted retry.

  Resend marks `email.bounced` and `email.complained` permanent while leaving
  `email.delivery_delayed` transient. SendGrid needs more care: it reports hard
  bounces and temporary blocks through the _same_ `bounce` event, separated only
  by a `type` field, so `type: 'blocked'`, `deferred`, and `blocked` are treated
  as transient while `bounce`, `dropped`, and `spamreport` are permanent.

- 1abb35e: Add `@msgly/exotel` — SMS for the Indian market.

  Sends via Exotel's REST API and receives inbound SMS from its callback, with
  first-class DLT support (`dltEntityId` / `dltTemplateId`, overridable per
  message so one campaign can span several registered templates) and
  transactional vs. promotional routing.

  Exotel does not sign its webhooks, so the adapter supports a `webhookToken`
  shared secret checked in constant time against `?token=…`. Without it any caller
  that reaches your endpoint can forge inbound SMS — the README says so plainly.

  `verifyCredentials` distinguishes a bad key/token from an account that lives on
  the other regional cluster, which otherwise surfaces as a confusing 404.

- cacc6be: Add `@msgly/msg91` — India SMS via MSG91's DLT Flow API.

  Unlike the other SMS adapters this one declares `templates: true`, because
  MSG91's v5 API is template-first: DLT regulation forbids arbitrary text.
  `TemplateContent` names a registered template directly, while `TextContent` is
  injected into a configurable variable of `defaultTemplateId`, overridable per
  message via `metadata.templateId`. Sending text with no template resolved fails
  with an actionable error before spending an API call.

  Handles two MSG91 quirks that otherwise cause silent misreporting: a failed send
  returns `type: 'error'` on HTTP 200, and an invalid auth key returns an error
  string on HTTP 200. Phone numbers are normalised to the bare digits MSG91
  expects. Inbound parsing accepts the several field spellings MSG91 uses across
  its product lines, and `webhookToken` guards the unsigned webhook.

- e919523: Add `@msgly/plivo` and `@msgly/resend`.

  **Plivo** — global SMS and MMS with V3 webhook signature verification
  (`base64(HMAC-SHA256(authToken, url + nonce))`), accepting multiple
  comma-separated signatures so key rotation doesn't cause an outage. Because
  Plivo signs the URL, `webhookUrl` must match exactly, and the README says so.
  MMS with a non-URL media reference fails fast rather than being rejected by the
  API, since Plivo has no upload endpoint.

  **Resend** — transactional email over HTTP, so unlike `@msgly/smtp` it is
  Edge-compatible. Verifies Svix-signed webhooks including a timestamp window that
  bounds replay. Delivery events (`email.sent`/`delivered`/`bounced`/…) are
  deliberately kept out of `handleWebhook` and exposed via `parseDeliveryEvent`
  instead, so status updates don't pollute the inbound message handler.
  `verifyCredentials` checks that the sending domain is registered _and verified_,
  which is the usual cause of a confusing first-send 422.

- 3aa2fdc: Add `@msgly/rocketchat` and `@msgly/googlechat`.

  **Rocket.Chat** — self-hosted team chat over the v1 REST API, authenticated with
  the `X-Auth-Token`/`X-User-Id` pair Rocket.Chat requires. Errors often arrive as
  HTTP 200 with `success: false`, so the flag is treated as the real result rather
  than reporting rejected messages as sent. Unsigned outgoing webhooks are guarded
  by a constant-time token check, and `bot`-marked posts are dropped to avoid a
  reply loop. The room is the addressable id; replies thread via `tmid`.

  **Google Chat** — two-legged service-account auth: an RS256 JWT assertion is
  signed with Web Crypto and exchanged for a cached OAuth token, with concurrent
  refreshes collapsed. Inbound requests carry a Google-signed bearer JWT, verified
  against Google's JWKS with `iss`/`aud`/`exp`/`nbf` checked and `alg` pinned to
  RS256 so algorithm-confusion attempts fail. Inbound text prefers `argumentText`
  (the @mention stripped), `CARD_CLICKED` events surface as interactions, and
  threaded replies set `messageReplyOption` — without it a reply silently starts a
  new thread.

- 20e7146: Add `@msgly/smtp` — an SMTP + IMAP adapter covering Yahoo, Zoho, Fastmail,
  iCloud, AOL, and any custom mail server.

  Sends via SMTP (plain-text or HTML bodies, threaded replies, optional
  attachments) and receives via IMAP polling with a persistable UID cursor so
  restarts resume where they left off. Omit the `imap` config for a send-only
  adapter.

  This package is **Node-only** — SMTP and IMAP are raw TCP/TLS protocols that
  `fetch` cannot speak, so unlike the other adapters it does not run on Edge or in
  a browser. It depends on `nodemailer` and `imapflow`.

  Core's `ChannelName` is now open (`KnownChannel | (string & {})`), so
  third-party adapters can define their own channel without a core release.
  Built-in channel names keep autocomplete.

- 0b22265: Add opt-out handling to campaigns.

  `sendBulk` previously sent to every recipient unconditionally, with no way to
  honour an opt-out. Honouring opt-outs is a legal requirement — TCPA and
  TRAI/DLT for SMS, CAN-SPAM and GDPR for email — so this closes a real gap
  rather than adding a convenience.

  - **`SuppressionStore`** — consulted before each send. Suppressed recipients are
    reported as a new `skipped` result rather than `failed`, because nothing went
    wrong and retrying them would be the violation. In-memory and KV-backed
    implementations ship with core; set it once via
    `createHub({ suppressionStore })` or per call. Pass `suppression: false` to
    bypass for genuinely transactional sends.
  - The check runs **before** a rate-limit token is taken, so suppressed
    recipients cost no campaign throughput, and it **fails closed** — if the store
    is unreachable the send is skipped and reported as failed, since not sending
    is the recoverable mistake.
  - **`detectConsentIntent` / `applyConsentIntent`** — recognise STOP, UNSUBSCRIBE,
    CANCEL and their non-English equivalents (plus START to resubscribe) and apply
    them to the store. Matching is whole-message only, so "please stop sending the
    weekly digest" is not treated as a global opt-out.
  - **`List-Unsubscribe` / `List-Unsubscribe-Post`** on the SMTP, Resend and
    SendGrid adapters via a new `unsubscribe` config, overridable per message for
    per-recipient tokens. Gmail and Yahoo have required these from bulk senders
    since February 2024. `List-Unsubscribe-Post` is emitted only when a URL is
    present, since one-click is an HTTP mechanism.

- c89d542: Add `@msgly/telnyx` and `@msgly/sendgrid`.

  **Telnyx** — global SMS/MMS verified with Ed25519 over `"{timestamp}|{body}"`,
  plus a timestamp window bounding replay. Verification fails closed when the
  runtime's Web Crypto lacks Ed25519, rather than silently accepting unverified
  webhooks.

  **SendGrid** — transactional email over HTTP, Edge-compatible. Handles the two
  differently-secured webhooks explicitly: the unsigned Inbound Parse endpoint is
  guarded by a URL token and produces messages, while the ECDSA-signed Event
  Webhook produces receipts via `parseDeliveryEvents`. The ECDSA signature is
  DER-encoded and is converted to the P1363 form Web Crypto requires — passing DER
  straight through fails every time. Reads the message id from the `X-Message-Id`
  header, since `/v3/mail/send` returns 202 with an empty body, and
  `verifyCredentials` confirms the key actually carries the `mail.send` scope.

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

- 1abb35e: Add `@msgly/vonage-sms` — global SMS via Vonage (Nexmo).

  Correctly treats Vonage's per-message `status` code as the result rather than
  the HTTP status, which is always 200 even for rejected messages, and translates
  the common failure codes into readable explanations. Non-GSM-7 text is
  automatically sent as `unicode` so emoji and non-Latin scripts are not mangled.

  Supports signed webhooks: pass `signatureSecret` and the adapter verifies the
  HMAC over sorted parameters in constant time. The legacy `md5hash` scheme is
  explicitly rejected with guidance rather than silently accepting unverified
  requests, since Web Crypto has no MD5.

### Patch Changes

- 20e7146: Add the missing root ESLint configuration. `pnpm lint` failed in every package
  with "ESLint couldn't find a configuration file", so the lint script had never
  actually run. Enabling it surfaced two unused imports, now removed.
- dd8ce7d: Repository and packaging fixes.

  - **Add the MIT LICENSE.** Every package declared `"license": "MIT"` with no
    licence text anywhere in the repo. The file is now present and, critically,
    listed in each package's `files` array so it actually ships in the published
    tarball rather than only living in git.
  - **Declare `engines: node >=18` on every package.** Only `@msgly/smtp` did.
    Every adapter needs `fetch` and Web Crypto, so a Node 16 user previously got
    a confusing runtime crash instead of an install-time warning.
  - **Add CI.** The README has always shown a CI badge pointing at
    `.github/workflows/ci.yml`, which did not exist — nothing verified the test
    suite on a pull request. The workflow builds, typechecks, lints and tests
    across Node 18/20/22, and a second job verifies all 26 packages actually pack
    with `dist/`, `README.md` and `LICENSE` before any release is attempted.
  - **Remove the stale `package-lock.json`.** This is a pnpm workspace; the npm
    lockfile caused wrong installs, and it is now gitignored.
  - Add the missing `@msgly/twilio-sms` and `@msgly/twilio-voice` READMEs, so all
    26 packages document themselves.
