---
'@msgly/vonage-sms': minor
'@msgly/core': minor
---

Add `@msgly/vonage-sms` — global SMS via Vonage (Nexmo).

Correctly treats Vonage's per-message `status` code as the result rather than
the HTTP status, which is always 200 even for rejected messages, and translates
the common failure codes into readable explanations. Non-GSM-7 text is
automatically sent as `unicode` so emoji and non-Latin scripts are not mangled.

Supports signed webhooks: pass `signatureSecret` and the adapter verifies the
HMAC over sorted parameters in constant time. The legacy `md5hash` scheme is
explicitly rejected with guidance rather than silently accepting unverified
requests, since Web Crypto has no MD5.
