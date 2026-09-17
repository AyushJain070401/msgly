# @msgly/rcs-twilio

## 1.9.0

### Patch Changes

- Updated dependencies [90e48f6]
  - @msgly/core@1.9.0

## 1.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
