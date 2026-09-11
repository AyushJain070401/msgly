import type { Metadata } from 'next';
import Nav from '../components/Nav';
import Reveal from '../components/Reveal';
import ChangelogList from '../components/ChangelogList';
import { REPO } from '../data';
import { latestVersion, releases } from '../changelog-data';

export const metadata: Metadata = {
  title: 'Changelog — Msgly',
  description:
    'Every Msgly release, with the full engineering note for each change and the packages it touched.',
  alternates: { canonical: 'https://ayushjain070401.github.io/msgly/changelog/' },
};

export default function Changelog() {
  const noteCount = releases.reduce((n, r) => n + r.notes.length, 0);

  return (
    <>
      <Nav home={false} />
      <main id="top">
        <section className="hero cl-hero">
          <div className="wrap">
            <Reveal>
              <span className="pill">
                <span className="dot" /> Latest · v{latestVersion}
              </span>
              <h1 style={{ marginTop: 22 }}>
                Changelog
                <br />
                <span className="grad">every release, in full.</span>
              </h1>
              <p className="hero-sub">
                {releases.length} releases and {noteCount} notes, generated straight from the package
                changelogs — so what you read here is exactly what shipped to npm. All{' '}
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>@msgly/*</code>{' '}
                packages version in lockstep, so one version number describes the whole library.
              </p>
              <div className="hero-cta">
                <a className="btn primary" href="#releases">
                  Jump to releases ↓
                </a>
                <a className="btn" href={`${REPO}/releases`} target="_blank" rel="noreferrer">
                  Releases on GitHub
                </a>
              </div>
            </Reveal>
          </div>
        </section>

        <section id="releases">
          <div className="wrap">
            <div className="callout cl-upgrade">
              <b>Upgrading from 1.5.0 or earlier? Read this first.</b>
              <p>
                Nothing was removed and no call signature changed, so existing code keeps
                working. One item is time-critical: <code>@msgly/whatsapp</code>,{' '}
                <code>@msgly/instagram</code> and <code>@msgly/messenger</code> defaulted to
                Meta Graph API <code>v20.0</code>, which{' '}
                <b>Meta retires on 24 September 2026</b>. Upgrading the packages is the whole
                fix — unless you pinned <code>apiVersion</code> yourself, in which case your
                explicit value still wins and must be raised.{' '}
                <a href={`${REPO}#upgrading-to-160`} target="_blank" rel="noreferrer">
                  Full migration guide →
                </a>
              </p>
            </div>
            {/*
              Deliberately not wrapped in <Reveal>: it is the page's primary
              content, and Reveal's 0.12 threshold can never be met by an
              element taller than the viewport, which hid the whole list on
              phones.
            */}
            <ChangelogList releases={releases} />
          </div>
        </section>

        <footer>
          <div className="wrap footer-inner">
            <span>MIT licensed · built for developers who ship on more than one channel.</span>
            <span>
              <a href={REPO} target="_blank" rel="noreferrer">
                GitHub
              </a>
              {' · '}
              <a href="https://www.npmjs.com/org/msgly" target="_blank" rel="noreferrer">
                npm
              </a>
            </span>
          </div>
        </footer>
      </main>
    </>
  );
}
