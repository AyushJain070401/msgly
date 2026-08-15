# msgly.dev site

The static marketing/docs site for msgly. Next.js App Router with `output: 'export'` — no server, no runtime data, deployable to GitHub Pages.

This directory is deliberately **outside** the pnpm workspace (`pnpm-workspace.yaml` only globs `packages/*` and `examples/*`) and uses npm, so building the site never touches the library's dependency graph.

## Local development

```bash
cd site && npm install && npm run dev
```

Then open http://localhost:4321.

## Build

```bash
npm run build
```

Output lands in `site/out/`. To preview exactly what GitHub Pages will serve, build with the base path first:

```bash
BASE_PATH=/msgly npm run build
```

## Deployment

`.github/workflows/pages.yml` builds and deploys on every push to `main` that touches `site/`, and can be run manually via **Actions → Deploy site to GitHub Pages → Run workflow**.

One-time setup: **Settings → Pages → Build and deployment → Source: GitHub Actions**.

The workflow sets `BASE_PATH=/${{ github.event.repository.name }}` because project pages are served from `https://<user>.github.io/<repo>/`. If you later attach a custom domain (served from the root), drop that env var and add a `public/CNAME` file.

## Brand logos

Channel logos are real brand marks baked into [`app/icons.ts`](app/icons.ts) from [simple-icons](https://simpleicons.org) (icons are CC0; the marks stay the property of their owners). The generator runs on demand, so the 3000-icon package stays a devDependency and never reaches the bundle:

```bash
npm run gen:icons
```

simple-icons has dropped a number of corporate marks over trademark policy — Slack, AWS/SES, Twilio, Microsoft, SendGrid and the smaller SMS vendors among them. Those render as a monogram tile painted in the brand's own colour, configured in `MONOGRAMS` inside [`scripts/gen-icons.mjs`](scripts/gen-icons.mjs). Drop a real SVG path in there if you obtain one you're licensed to use.

## Editing content

Nearly all copy lives in [`app/data.ts`](app/data.ts) — the channel list, feature blurbs, quickstart steps and code samples. Add a channel there and it appears in the grid, the filters, the search and the hero ticker automatically. Keep it in sync with the root `README.md`.
