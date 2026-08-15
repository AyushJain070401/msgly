'use client';

import { useEffect, useState } from 'react';
import { REPO } from '../data';

const LINKS = [
  { href: '#channels', label: 'Channels' },
  { href: '#quickstart', label: 'Quickstart' },
  { href: '#features', label: 'Features' },
  { href: '#campaigns', label: 'Campaigns' },
  { href: '#architecture', label: 'Architecture' },
];

export default function Nav() {
  const [scrolled, setScrolled] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <nav className={`nav${scrolled ? ' scrolled' : ''}`}>
      <div className="wrap nav-inner">
        <a className="brand" href="#top">
          msgly
        </a>
        <div className="nav-links">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="hide-sm">
              {l.label}
            </a>
          ))}
          <a className="btn star" href={REPO} target="_blank" rel="noreferrer">
            <svg width="14" height="14" viewBox="0 0 24 24" aria-hidden focusable="false">
              <path
                fill="currentColor"
                d="M12 2.4l2.9 5.9 6.5.9-4.7 4.6 1.1 6.5-5.8-3-5.8 3 1.1-6.5L2.6 9.2l6.5-.9L12 2.4Z"
              />
            </svg>
            Star this repo
          </a>
        </div>
      </div>
    </nav>
  );
}
