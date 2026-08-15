# @msgly/wechat

## 1.1.0

### Patch Changes

- 20e7146: Add the missing root ESLint configuration. `pnpm lint` failed in every package
  with "ESLint couldn't find a configuration file", so the lint script had never
  actually run. Enabling it surfaced two unused imports, now removed.
- 20e7146: Harden WeChat webhook signature verification.

  - Compare the computed signature in constant time. Every other adapter already
    did this; WeChat used `===`, which leaks the expected digest byte by byte
    through response timing.
  - Reject stale timestamps (default window: 5 minutes, configurable via
    `maxTimestampSkewSec`, `0` to disable). WeChat's signature covers only
    `token + timestamp + nonce` and not the request body, so a single captured
    triple previously stayed valid indefinitely and could be replayed with an
    attacker-chosen payload.

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
