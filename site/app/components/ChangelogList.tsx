'use client';

import { useMemo, useState } from 'react';
import Markdown from './Markdown';
import type { Release } from '../changelog-data';

const KIND_TAG: Record<string, string> = {
  Major: 'bad',
  Minor: 'good',
  Patch: 'warn',
};

function formatDate(iso: string | null) {
  if (!iso) return 'Unreleased';
  // Parsed as UTC deliberately: a bare YYYY-MM-DD read in local time can slip a
  // day backwards for readers west of UTC.
  return new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', {
    day: 'numeric',
    month: 'short',
    year: 'numeric',
    timeZone: 'UTC',
  });
}

export default function ChangelogList({ releases }: { releases: Release[] }) {
  const [pkg, setPkg] = useState('All packages');
  const [open, setOpen] = useState<string | null>(releases[0]?.version ?? null);

  const packages = useMemo(() => {
    const all = new Set<string>();
    for (const r of releases) for (const n of r.notes) for (const p of n.packages) all.add(p);
    return ['All packages', ...[...all].sort()];
  }, [releases]);

  const shown = useMemo(() => {
    if (pkg === 'All packages') return releases;
    return releases
      .map((r) => ({ ...r, notes: r.notes.filter((n) => n.packages.includes(pkg)) }))
      .filter((r) => r.notes.length > 0);
  }, [releases, pkg]);

  return (
    <>
      <div className="toolbar">
        <select
          className="search"
          value={pkg}
          onChange={(e) => setPkg(e.target.value)}
          aria-label="Filter releases by package"
        >
          {packages.map((p) => (
            <option key={p} value={p}>
              {p}
            </option>
          ))}
        </select>
        <span className="cl-count">
          {shown.length} release{shown.length === 1 ? '' : 's'}
          {pkg !== 'All packages' && ` affecting ${pkg}`}
        </span>
      </div>

      {shown.length === 0 ? (
        <p className="empty">No releases have touched {pkg} yet.</p>
      ) : (
        <ol className="cl-list">
          {shown.map((rel) => (
            <li key={rel.version} className="cl-release">
              <div className="cl-rail" aria-hidden>
                <span className="cl-dot" />
              </div>

              <div className="cl-body">
                <header className="cl-head">
                  <h2 id={`v${rel.version}`}>
                    <a href={`#v${rel.version}`}>v{rel.version}</a>
                  </h2>
                  <span className={`tag ${rel.date ? '' : 'warn'}`}>{formatDate(rel.date)}</span>
                  <span className="cl-meta">{rel.packageCount} packages</span>
                </header>

                {rel.notes.map((note, i) => {
                  const id = `${rel.version}-${i}`;
                  const isOpen = open === id || open === rel.version;
                  return (
                    <article key={id} className="cl-note">
                      <div className="cl-note-head">
                        <span className={`tag ${KIND_TAG[note.kind] ?? ''}`}>{note.kind}</span>
                        <h3>{note.headline}</h3>
                      </div>

                      {isOpen ? (
                        <div className="cl-detail">
                          <Markdown body={note.body} skipHeadline={note.headline} />
                          <p className="cl-pkgs">
                            {note.packages.map((p) => (
                              <span key={p} className="pkg">
                                {p}
                              </span>
                            ))}
                          </p>
                        </div>
                      ) : null}

                      <button className="btn cl-toggle" onClick={() => setOpen(isOpen ? null : id)}>
                        {isOpen ? 'Show less' : 'Read the full note'}
                      </button>
                    </article>
                  );
                })}
              </div>
            </li>
          ))}
        </ol>
      )}
    </>
  );
}
