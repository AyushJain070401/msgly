# Releasing

All `@msgly/*` packages share **one version number**. They are versioned and
published together, so `@msgly/core@1.1.0` always pairs with
`@msgly/telegram@1.1.0`. This is enforced two ways: `fixed` in
`.changeset/config.json`, and a CI check that fails the release if versions
ever diverge.

## The flow

Releases are automatic on `main`, in two steps:

```
                 ┌─ changesets pending?  ──→ opens/updates "chore: release" PR
push to main ────┤
                 └─ none pending?        ──→ publishes every package to npm
```

1. **You merge a feature PR** that includes a changeset. The Release workflow
   sees pending changesets and opens (or updates) a PR titled **chore: release**
   containing the version bump and generated CHANGELOGs.
2. **You merge that PR.** That is another push to `main`. This time there are no
   pending changesets, so the workflow publishes all 26 packages to npm and
   pushes git tags.

The PR in the middle is deliberate: it is your chance to see the exact version
and changelog before anything irreversible happens. npm does not allow reusing
a version number, so a bad publish cannot be undone — only superseded.

## Adding a changeset

Every user-facing change needs one:

```bash
pnpm changeset
```

Pick the bump type and describe the change. Because the packages are a fixed
group, the largest bump among pending changesets applies to **all** of them.

- `patch` — bug fix
- `minor` — new feature, new adapter, backwards-compatible
- `major` — breaking change

The description lands verbatim in the published CHANGELOG, so write it for
someone upgrading, not for yourself.

## One-time setup

The workflow needs one secret and one permission.

### 1. Create an npm automation token

On npmjs.com → your avatar → **Access Tokens** → **Generate New Token** →
**Classic Token** → type **Automation**.

Automation tokens bypass 2FA, which is required for CI publishing. A "Publish"
token will fail in Actions if you have 2FA enforced.

Confirm you can publish to the scope first:

```bash
npm whoami
npm access list packages @msgly
```

### 2. Add it to the repository

GitHub → repo **Settings** → **Secrets and variables** → **Actions** →
**New repository secret**:

- Name: `NPM_TOKEN`
- Value: the automation token

### 3. Allow Actions to open pull requests

GitHub → **Settings** → **Actions** → **General** → **Workflow permissions**:

- Select **Read and write permissions**
- Tick **Allow GitHub Actions to create and approve pull requests**

Without the second box, the workflow fails with `GitHub Actions is not
permitted to create pull requests`.

### 4. First publish

12 of the 26 packages have never been published. The first release creates
them. Because `publishConfig.access` is `public` on every package, scoped
packages publish publicly rather than erroring on a private-package paywall.

If the npm org does not exist yet, create it before the first run — an
`@msgly` scope that is not yours will fail with `403 Forbidden`.

## Checking a release

- **Actions** tab → **Release** workflow → the run summary lists what published.
- `npm view @msgly/core version` should match every other package.

## If a publish fails partway

Rerun the workflow. `changeset publish` skips versions already on npm, so a
retry completes only the packages that did not make it. This is why the CI
`pack` job exists — it catches a malformed package before any publish starts.

## Provenance

Published tarballs carry [npm provenance](https://docs.npmjs.com/generating-provenance-statements),
linking each one to the commit and workflow run that built it. This needs the
repository to be public. If it is private, drop `NPM_CONFIG_PROVENANCE` from
`.github/workflows/release.yml` or the publish step will fail.
