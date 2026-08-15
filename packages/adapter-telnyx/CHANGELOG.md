# @msgly/telnyx

## 1.1.0

### Minor Changes

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
