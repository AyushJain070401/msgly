/**
 * Builds app/capabilities.json by instantiating every adapter and reading the
 * `capabilities` object it actually reports.
 *
 * This is deliberately not a hand-maintained table. v1.6.0 shipped a fix for
 * five adapters that advertised `capabilities.reactions: true` while the
 * library had no way to send a reaction — a table copied by hand is exactly how
 * that survives. Reading the built adapters means the site cannot claim a
 * capability the code does not report.
 *
 *   node scripts/gen-capabilities.mjs
 *
 * Run after `turbo run build`, since it imports each package's dist.
 */
import { readdirSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { pathToFileURL } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const packagesDir = join(here, '..', '..', 'packages');
const outFile = join(here, '..', 'app', 'capabilities.json');

/**
 * Three adapters read string fields off their config during construction
 * (a server URL, a token prefix), so `{}` throws. This proxy answers every
 * property with a string, which is enough to get past construction.
 *
 * Capabilities are compared against the `{}` result wherever both work, and no
 * adapter currently reports different capabilities for the two — the opt-in
 * features (attachments) need a shaped object, not merely a truthy value, so
 * they stay off in both. If that ever changes, this script would start
 * reporting an opt-in feature as though it were always on, so it fails loudly
 * rather than silently preferring one.
 */
const LOOSE = new Proxy({}, { get: (_t, k) => (k === 'then' ? undefined : 'x') });

function construct(mod) {
  const entry = Object.entries(mod).find(
    ([k, v]) => /^create.*Adapter$/.test(k) && typeof v === 'function',
  );
  if (!entry) return null;
  const factory = entry[1];

  let strict = null;
  try {
    strict = factory({}).capabilities;
  } catch {
    /* needs a shaped config — fall through to LOOSE */
  }

  const loose = factory(LOOSE).capabilities;

  if (strict && JSON.stringify(strict) !== JSON.stringify(loose)) {
    throw new Error(
      'capabilities differ between an empty and a populated config — this ' +
        'script can no longer report a single honest answer for this adapter',
    );
  }
  return strict ?? loose;
}

/** Flatten the nested shape into the flags a table can render. */
function flatten(c) {
  return {
    text: !!c.text,
    image: !!c.media?.image,
    video: !!c.media?.video,
    audio: !!c.media?.audio,
    file: !!c.media?.file,
    buttons: !!c.interactive?.buttons,
    quickReplies: !!c.interactive?.quickReplies,
    lists: !!c.interactive?.lists,
    ctaUrl: !!c.interactive?.ctaUrl,
    cards: !!c.interactive?.cards,
    templates: !!c.templates,
    reactions: !!c.reactions,
    typing: !!c.typing,
  };
}

const dirs = readdirSync(packagesDir)
  .filter((d) => d.startsWith('adapter-'))
  .sort();

const out = {};
const skipped = [];

// Adapters log configuration warnings on construction; this script constructs
// all of them, and that noise is not the operator's problem.
const realWarn = console.warn;
const realLog = console.log;
console.warn = () => {};
console.log = () => {};

for (const dir of dirs) {
  const dist = join(packagesDir, dir, 'dist', 'index.js');
  if (!existsSync(dist)) {
    skipped.push([dir, 'not built']);
    continue;
  }
  try {
    const mod = await import(pathToFileURL(dist).href);
    const caps = construct(mod);
    if (!caps) {
      skipped.push([dir, 'no adapter factory export']);
      continue;
    }
    const pkgJson = await import(pathToFileURL(join(packagesDir, dir, 'package.json')).href, {
      with: { type: 'json' },
    });
    out[pkgJson.default.name] = flatten(caps);
  } catch (err) {
    skipped.push([dir, err.message]);
  }
}

console.log = realLog;
console.warn = realWarn;

writeFileSync(outFile, `${JSON.stringify(out, null, 2)}\n`);

console.log(
  `capabilities: ${Object.keys(out).length} adapters → app/capabilities.json`,
);
if (skipped.length) {
  console.warn('skipped:');
  for (const [d, why] of skipped) console.warn(`  ${d} — ${why}`);
}
