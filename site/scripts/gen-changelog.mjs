/**
 * Builds app/changelog.json from the per-package CHANGELOG.md files that
 * changesets writes at release time.
 *
 * The site reads the generated JSON rather than the markdown so the changelog
 * page can group, filter and link by package — and so it cannot drift from what
 * was actually published. Re-run after every release:
 *
 *   node scripts/gen-changelog.mjs
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, '..', '..', 'packages');
const outFile = join(here, '..', 'app', 'changelog.json');

/** changesets writes this for packages that only moved because a dep moved. */
const DEP_ONLY = /^Updated dependencies/;

/**
 * Release dates come from the git tag changesets' release action pushes.
 * A version that has not been tagged yet (an unreleased bump sitting on a
 * branch) simply has no date, and the page labels it accordingly.
 */
function tagDates() {
  const dates = {};
  try {
    const raw = execFileSync(
      'git',
      ['for-each-ref', '--format=%(refname:short)\t%(creatordate:short)', 'refs/tags'],
      { cwd: packagesDir, encoding: 'utf8' },
    );
    for (const line of raw.split('\n')) {
      const [ref, date] = line.split('\t');
      // Tags are per package (@msgly/core@1.5.0) but versions move in lockstep,
      // so the first tag seen for a version is representative.
      const version = ref?.split('@').pop();
      if (version && date && !dates[version]) dates[version] = date;
    }
  } catch {
    // Not a git checkout (a tarball build, say) — dates are optional.
  }
  return dates;
}

/** Split one CHANGELOG.md into { version -> [{ kind, body }] }. */
function parseChangelog(md) {
  const out = {};
  // Sections look like "## 1.6.0" then "### Minor Changes" then "- body".
  const versionBlocks = md.split(/^## (?=\d)/m).slice(1);

  for (const block of versionBlocks) {
    const version = block.slice(0, block.indexOf('\n')).trim();
    const entries = [];
    const kindBlocks = block.split(/^### /m).slice(1);

    for (const kb of kindBlocks) {
      const kind = kb.slice(0, kb.indexOf('\n')).trim().replace(/ Changes$/, '');
      const rest = kb.slice(kb.indexOf('\n') + 1);
      // Entries are top-level "- " list items; nested content is indented.
      for (const item of rest.split(/^- /m).slice(1)) {
        // Drop the changeset commit hash prefix ("27fa311: ") when present.
        const body = item.replace(/^[0-9a-f]{7,40}: /, '').trimEnd();
        if (body) entries.push({ kind, body });
      }
    }
    if (entries.length) out[version] = entries;
  }
  return out;
}

/**
 * Collapse a body to its first sentence for the summary line, without cutting
 * mid-markdown (bold spans, inline code) which would render as stray markers.
 */
function headline(body) {
  const firstPara = body.split(/\n\s*\n/)[0].replace(/\s+/g, ' ').trim();
  const stop = firstPara.search(/\.(\s|$)/);
  const text = stop === -1 ? firstPara : firstPara.slice(0, stop + 1);
  return text.replace(/`/g, '').replace(/\*\*/g, '');
}

const dates = tagDates();
const releases = new Map();

for (const dir of readdirSync(packagesDir)) {
  let md;
  try {
    md = readFileSync(join(packagesDir, dir, 'CHANGELOG.md'), 'utf8');
  } catch {
    continue; // no changelog yet
  }
  const pkg = JSON.parse(readFileSync(join(packagesDir, dir, 'package.json'), 'utf8')).name;

  for (const [version, entries] of Object.entries(parseChangelog(md))) {
    if (!releases.has(version)) {
      releases.set(version, { version, date: dates[version] ?? null, notes: [], packages: new Set() });
    }
    const rel = releases.get(version);
    rel.packages.add(pkg);

    for (const { kind, body } of entries) {
      if (DEP_ONLY.test(body)) continue; // noise: says nothing about the release
      // The same changeset is copied into every affected package's changelog,
      // so key on the text to keep one canonical note per release.
      const existing = rel.notes.find((n) => n.body === body);
      if (existing) existing.packages.push(pkg);
      else rel.notes.push({ kind, headline: headline(body), body, packages: [pkg] });
    }
  }
}

const sortVersion = (a, b) => {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  return pb[0] - pa[0] || pb[1] - pa[1] || pb[2] - pa[2];
};

const data = [...releases.values()]
  .sort((a, b) => sortVersion(a.version, b.version))
  .map((r) => ({
    version: r.version,
    date: r.date,
    packageCount: r.packages.size,
    notes: r.notes.map((n) => ({ ...n, packages: n.packages.sort() })),
  }))
  // A release whose every note was dependency noise has nothing to show.
  .filter((r) => r.notes.length > 0);

writeFileSync(outFile, JSON.stringify(data, null, 2) + '\n');
console.log(`changelog: ${data.length} releases → app/changelog.json`);
