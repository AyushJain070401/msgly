---
'@msgly/core': minor
---

Require Node 20 or newer.

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
