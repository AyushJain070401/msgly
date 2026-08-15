'use client';

import { useMemo, useState } from 'react';
import { categories, channels } from '../data';
import BrandMark, { markColor } from './BrandMark';

// Short form for the card tag; the full wording lives in the tier table below.
const SHORT: Record<string, string> = {
  Outbound: 'Outbound',
  'Policy-gated': 'Policy-gated',
  'Reply-only': 'Reply-only',
  'Not for campaigns': 'No campaigns',
};

const TONE: Record<string, string> = {
  Outbound: 'good',
  'Policy-gated': 'warn',
  'Reply-only': 'warn',
  'Not for campaigns': 'bad',
  '—': '',
};

export default function ChannelExplorer() {
  const [cat, setCat] = useState<string>('All');
  const [q, setQ] = useState('');

  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return channels.filter((c) => {
      if (cat !== 'All' && c.category !== cat) return false;
      if (!needle) return true;
      return `${c.name} ${c.pkg} ${c.notes}`.toLowerCase().includes(needle);
    });
  }, [cat, q]);

  function track(e: React.MouseEvent<HTMLDivElement>) {
    const el = e.currentTarget;
    const r = el.getBoundingClientRect();
    el.style.setProperty('--mx', `${e.clientX - r.left}px`);
    el.style.setProperty('--my', `${e.clientY - r.top}px`);
  }

  return (
    <>
      <div className="toolbar">
        {categories.map((c) => (
          <button key={c} className="filter" data-active={cat === c} onClick={() => setCat(c)} type="button">
            {c}
          </button>
        ))}
        <input
          className="search"
          placeholder="search channels…"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          aria-label="Search channels"
        />
      </div>

      {shown.length === 0 ? (
        <p className="empty">No channel matches “{q}”. Channel names are open — you can publish your own adapter.</p>
      ) : (
        <div className="cards">
          {shown.map((c, i) => (
            <div
              className="card pop channel-card"
              key={c.pkg}
              onMouseMove={track}
              style={{ animationDelay: `${Math.min(i, 12) * 35}ms`, ['--brand' as string]: markColor(c.pkg) }}
            >
              <div className="card-head">
                <div className="glyph">
                  <BrandMark pkg={c.pkg} />
                </div>
                <div>
                  <h3>{c.name}</h3>
                  <div className="pkg">{c.pkg}</div>
                </div>
                {c.campaign !== '—' ? (
                  <span className={`tag ${TONE[c.campaign]}`} title={c.campaign}>
                    {SHORT[c.campaign]}
                  </span>
                ) : null}
              </div>
              <p>{c.notes}</p>
            </div>
          ))}
        </div>
      )}
    </>
  );
}
