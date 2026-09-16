# @msgly/web-push

## 1.8.0

### Minor Changes

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

### Patch Changes

- Updated dependencies [8ad88fb]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
- Updated dependencies [79a2749]
  - @msgly/core@1.8.0
