# @msgly/ses

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

### Patch Changes

- Updated dependencies [7bae280]
  - @msgly/core@1.2.0
