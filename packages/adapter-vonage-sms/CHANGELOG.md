# @msgly/vonage-sms

## 1.1.0

### Minor Changes

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
