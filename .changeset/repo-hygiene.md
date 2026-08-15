---
'@msgly/core': patch
---

Repository and packaging fixes.

- **Add the MIT LICENSE.** Every package declared `"license": "MIT"` with no
  licence text anywhere in the repo. The file is now present and, critically,
  listed in each package's `files` array so it actually ships in the published
  tarball rather than only living in git.
- **Declare `engines: node >=18` on every package.** Only `@msgly/smtp` did.
  Every adapter needs `fetch` and Web Crypto, so a Node 16 user previously got
  a confusing runtime crash instead of an install-time warning.
- **Add CI.** The README has always shown a CI badge pointing at
  `.github/workflows/ci.yml`, which did not exist — nothing verified the test
  suite on a pull request. The workflow builds, typechecks, lints and tests
  across Node 18/20/22, and a second job verifies all 26 packages actually pack
  with `dist/`, `README.md` and `LICENSE` before any release is attempted.
- **Remove the stale `package-lock.json`.** This is a pnpm workspace; the npm
  lockfile caused wrong installs, and it is now gitignored.
- Add the missing `@msgly/twilio-sms` and `@msgly/twilio-voice` READMEs, so all
  26 packages document themselves.
