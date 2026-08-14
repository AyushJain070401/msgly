---
'@msgly/core': patch
'@msgly/slack': patch
'@msgly/wechat': patch
---

Add the missing root ESLint configuration. `pnpm lint` failed in every package
with "ESLint couldn't find a configuration file", so the lint script had never
actually run. Enabling it surfaced two unused imports, now removed.
