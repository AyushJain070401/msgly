---
'@msgly/wechat': patch
---

Harden WeChat webhook signature verification.

- Compare the computed signature in constant time. Every other adapter already
  did this; WeChat used `===`, which leaks the expected digest byte by byte
  through response timing.
- Reject stale timestamps (default window: 5 minutes, configurable via
  `maxTimestampSkewSec`, `0` to disable). WeChat's signature covers only
  `token + timestamp + nonce` and not the request body, so a single captured
  triple previously stayed valid indefinitely and could be replayed with an
  attacker-chosen payload.
