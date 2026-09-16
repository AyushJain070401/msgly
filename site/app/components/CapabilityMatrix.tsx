'use client';

import { useMemo, useState } from 'react';

import { channels } from '../data';
import capabilities from '../capabilities.json';

type Flags = Record<string, boolean>;

/** Column groups, in the order the hub checks them. */
const GROUPS: { label: string; cols: { key: string; label: string }[] }[] = [
  {
    label: 'Content',
    cols: [
      { key: 'text', label: 'text' },
      { key: 'image', label: 'image' },
      { key: 'video', label: 'video' },
      { key: 'audio', label: 'audio' },
      { key: 'file', label: 'file' },
    ],
  },
  {
    label: 'Interactive',
    cols: [
      { key: 'buttons', label: 'buttons' },
      { key: 'quickReplies', label: 'quick replies' },
      { key: 'lists', label: 'lists' },
      { key: 'ctaUrl', label: 'cta url' },
      { key: 'cards', label: 'cards' },
    ],
  },
  {
    label: 'Conversation',
    cols: [
      { key: 'templates', label: 'templates' },
      { key: 'reactions', label: 'reactions' },
      { key: 'typing', label: 'typing' },
    ],
  },
];

const COLS = GROUPS.flatMap((g) => g.cols);
const CATEGORIES = ['All', 'Chat & social', 'Email', 'SMS & voice', 'Push', 'Publishing'];

export default function CapabilityMatrix() {
  const [cat, setCat] = useState('All');

  const rows = useMemo(
    () =>
      channels
        .filter((c) => c.category !== 'Core')
        .filter((c) => cat === 'All' || c.category === cat)
        .map((c) => ({ ...c, flags: (capabilities as Record<string, Flags>)[c.pkg] }))
        .filter((r) => r.flags),
    [cat],
  );

  return (
    <div className="matrix-wrap">
      <div className="toolbar">
        {CATEGORIES.map((c) => (
          <button
            key={c}
            type="button"
            className="filter"
            data-active={cat === c}
            onClick={() => setCat(c)}
          >
            {c}
          </button>
        ))}
      </div>

      <div className="matrix-scroll">
        <table className="matrix">
          <thead>
            <tr className="matrix-groups">
              <th />
              {GROUPS.map((g) => (
                <th key={g.label} colSpan={g.cols.length} scope="colgroup">
                  {g.label}
                </th>
              ))}
            </tr>
            <tr>
              <th scope="col">Channel</th>
              {COLS.map((c) => (
                <th key={c.key} scope="col">
                  <span>{c.label}</span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.pkg}>
                <th scope="row">
                  <span className="m-name">{r.name}</span>
                  <span className="m-pkg">{r.pkg}</span>
                </th>
                {COLS.map((c) => (
                  <td key={c.key} data-on={r.flags[c.key] ? 'yes' : 'no'}>
                    <span aria-hidden="true">{r.flags[c.key] ? '✓' : '—'}</span>
                    <span className="sr-only">
                      {r.flags[c.key] ? `${c.label} supported` : `${c.label} not supported`}
                    </span>
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="matrix-note">
        Generated at build time by constructing every adapter and reading the{' '}
        <code style={{ fontFamily: 'var(--mono)' }}>capabilities</code> object it reports — not a
        hand-maintained table. The hub checks these before sending and throws{' '}
        <code style={{ fontFamily: 'var(--mono)' }}>UnsupportedFeature</code> rather than silently
        degrading.
      </p>
    </div>
  );
}
