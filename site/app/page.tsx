import Nav from './components/Nav';
import Reveal from './components/Reveal';
import CodeBlock from './components/CodeBlock';
import ChannelExplorer from './components/ChannelExplorer';
import HeroOrbit from './components/HeroOrbit';
import CountUp from './components/CountUp';
import BrandMark from './components/BrandMark';
import {
  REPO,
  campaignCode,
  campaignTiers,
  channels,
  echoBot,
  features,
  quickstart,
  suppressionCode,
} from './data';

const adapterCount = channels.filter((c) => c.category !== 'Core').length;

export default function Home() {
  const ticker = channels.filter((c) => c.category !== 'Core');

  return (
    <>
      <Nav />
      <main id="top">
        {/* ---------------- hero ---------------- */}
        <section className="hero">
          <div className="wrap hero-grid">
            <Reveal>
              <span className="pill">
                <span className="dot" /> MIT licensed · TypeScript-native · Node 20+
              </span>
              <h1 style={{ marginTop: 22 }}>
                One API for
                <br />
                <span className="grad">every messaging channel.</span>
              </h1>
              <p className="hero-sub">
                Msgly collapses {adapterCount} platforms — chat, email, SMS, push and voice — into a single unified
                interface. Register the adapters you need, send and receive in one format, and stop learning a new
                webhook payload every quarter.
              </p>
              <div className="hero-cta">
                <a className="btn primary" href="#quickstart">
                  Get started →
                </a>
                <a className="btn" href={REPO} target="_blank" rel="noreferrer">
                  View on GitHub
                </a>
                <a className="btn" href="#channels">
                  Browse channels
                </a>
              </div>
            </Reveal>

            <Reveal delay={140} className="orbit-hold">
              <HeroOrbit />
            </Reveal>
          </div>

          <div className="wrap">
            <Reveal delay={120}>
              <div className="stats">
                <div className="stat">
                  <b>
                    <CountUp to={adapterCount} />
                  </b>
                  <span>channel adapters</span>
                </div>
                <div className="stat">
                  <b>
                    <CountUp to={1} />
                  </b>
                  <span>unified message type</span>
                </div>
                <div className="stat">
                  <b>
                    <CountUp to={0} />
                  </b>
                  <span>core changes to add a channel</span>
                </div>
                <div className="stat">
                  <b>MIT</b>
                  <span>licence</span>
                </div>
              </div>
            </Reveal>
          </div>

          <div className="ticker" aria-hidden>
            <div className="ticker-track">
              {[...ticker, ...ticker].map((c, i) => (
                <span className="chip logo-chip" key={`${c.pkg}-${i}`}>
                  <BrandMark pkg={c.pkg} size={18} />
                  {c.name}
                </span>
              ))}
            </div>
          </div>
          <div className="ticker" aria-hidden>
            <div className="ticker-track reverse">
              {[...ticker].reverse().concat([...ticker].reverse()).map((c, i) => (
                <span className="chip logo-chip ghost" key={`r-${c.pkg}-${i}`}>
                  <BrandMark pkg={c.pkg} size={18} />
                  {c.pkg}
                </span>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------- why ---------------- */}
        <section id="why">
          <div className="wrap split">
            <Reveal>
              <p className="eyebrow">Why msgly</p>
              <h2>Multi-channel shouldn&apos;t mean multi-codebase.</h2>
              <p className="lede">
                Building a chatbot or notification system that works across channels means learning many different APIs,
                webhook formats, signature schemes and media rules. Msgly gives you one TypeScript-native interface over
                all of them — with retries, idempotency, capability checks and rate limiting already handled.
              </p>
              <p className="lede">
                Channel names are open: <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>ChannelName</code>{' '}
                accepts any string, so you can publish a third-party adapter without waiting on a core release. Built-in
                names keep editor autocomplete.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <CodeBlock file="echo-bot.ts" code={echoBot} />
            </Reveal>
          </div>
        </section>

        {/* ---------------- channels ---------------- */}
        <section id="channels">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">Every module</p>
              <h2>{adapterCount} adapters, one contract.</h2>
              <p className="lede">
                Each channel is its own package, so you install only what you ship. Every adapter implements the same{' '}
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>Adapter</code> interface and brings
                its own credential check.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <ChannelExplorer />
            </Reveal>
            <Reveal delay={120}>
              <div className="callout">
                <b>No adapter for LinkedIn, X/Twitter DM or iMessage.</b>
                <p>
                  None of them has a usable API for this — LinkedIn&apos;s messaging API is partner-gated, and automating
                  the web UI violates their terms and gets accounts banned.
                </p>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------------- quickstart ---------------- */}
        <section id="quickstart">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">60-second quickstart</p>
              <h2>From zero to a live bot.</h2>
              <p className="lede">
                Start with Telegram — the easiest channel. No business verification, no Meta App, no Pages. You need
                Node.js 20+ and a Telegram account.
              </p>
            </Reveal>
            {quickstart.map((s, i) => (
              <Reveal key={s.step} delay={i * 70}>
                <div className="step">
                  <div className="step-no">{s.step}</div>
                  <div>
                    <h3>{s.title}</h3>
                    <p>{s.body}</p>
                    <CodeBlock code={s.code} />
                  </div>
                </div>
              </Reveal>
            ))}
          </div>
        </section>

        {/* ---------------- features ---------------- */}
        <section id="features">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">Features in detail</p>
              <h2>The unglamorous parts, already done.</h2>
              <p className="lede">
                Signature verification, exponential backoff, duplicate webhooks, per-platform size caps — the work that
                makes a messaging integration production-ready rather than demo-ready.
              </p>
            </Reveal>
            <div className="cards" style={{ marginTop: 34 }}>
              {features.map((f, i) => (
                <Reveal key={f.title} delay={(i % 3) * 80}>
                  <div className="card feature-card">
                    <h3>{f.title}</h3>
                    <p>{f.body}</p>
                    <div className="code-hold">
                      <CodeBlock code={f.code} />
                    </div>
                  </div>
                </Reveal>
              ))}
            </div>
          </div>
        </section>

        {/* ---------------- campaigns ---------------- */}
        <section id="campaigns">
          <div className="wrap split">
            <Reveal>
              <p className="eyebrow">Campaigns</p>
              <h2>Send to many, without getting throttled.</h2>
              <p className="lede">
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>hub.sendBulk()</code> fans one message
                out to a contact list, paced to the channel&apos;s rate limit. One bad recipient never aborts the
                campaign: it resolves rather than rejecting, and{' '}
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>result.results</code> comes back in
                input order so you can zip it against your own list.
              </p>
              <p className="lede">
                Conservative per-channel defaults ship built in (Slack 1/s, Twilio long code 1/s, Gmail ~2/s, Discord
                5/s, Telegram 25/s, WhatsApp 60/s), overridable per call, per adapter or per hub. Cancelling via{' '}
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>signal</code> gives you partial
                results instead of throwing them away.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <CodeBlock file="campaign.ts" code={campaignCode} />
            </Reveal>
          </div>

          <div className="wrap" style={{ marginTop: 44 }}>
            <Reveal>
              <h3 style={{ fontSize: 22, marginBottom: 18 }}>Which channels suit campaigns</h3>
              <div className="cards">
                {campaignTiers.map((t) => (
                  <div className="tier" key={t.tier}>
                    <span className={`tag ${t.tone}`} style={{ marginTop: 0 }}>
                      {t.tier}
                    </span>
                    <p className="ch">{t.channels}</p>
                    <p className="nt">{t.note}</p>
                  </div>
                ))}
              </div>
            </Reveal>
          </div>

          <div className="wrap split" style={{ marginTop: 52 }}>
            <Reveal>
              <p className="eyebrow">Compliance</p>
              <h2>Opt-outs are not optional.</h2>
              <p className="lede">
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>sendBulk</code> consults a{' '}
                <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>SuppressionStore</code> before every
                send — required by TCPA and TRAI/DLT for SMS, and CAN-SPAM and GDPR for email. Suppressed recipients come
                back as <b>skipped</b>, never failed, and cost no rate limit.
              </p>
              <p className="lede">
                If the store is unreachable the send is skipped rather than sent: not sending is the recoverable mistake.
                Only <b>permanent</b> failures suppress — a deferral or a full mailbox is left alone. Email adapters also
                emit the <code style={{ fontFamily: 'var(--mono)', color: 'var(--accent)' }}>List-Unsubscribe</code>{' '}
                header Gmail and Yahoo have required from bulk senders since February 2024.
              </p>
            </Reveal>
            <Reveal delay={120}>
              <CodeBlock file="suppression.ts" code={suppressionCode} />
            </Reveal>
          </div>
        </section>

        {/* ---------------- architecture ---------------- */}
        <section id="architecture">
          <div className="wrap">
            <Reveal>
              <p className="eyebrow">Architecture</p>
              <h2>Three layers, clean contracts.</h2>
              <p className="lede">
                Adding a new channel is one new package — no core changes needed.
              </p>
            </Reveal>
            <Reveal delay={100}>
              <div className="arch">
                <div className="layer">
                  <b>Your app</b>
                  <p>Express, Fastify, Next.js route handlers, a worker — anything that can receive an HTTP POST.</p>
                </div>
                <div className="arrow">
                  <span>↓</span>
                </div>
                <div className="layer">
                  <b>@msgly/core</b>
                  <p>
                    Unified types, the MessagingHub orchestrator, retries, idempotency, capability checks, rate limiting,
                    storage and suppression.
                  </p>
                </div>
                <div className="arrow">
                  <span>↓</span>
                </div>
                <div className="layer">
                  <b>Channel adapters</b>
                  <p>
                    One package per platform. Each implements the same <code style={{ fontFamily: 'var(--mono)' }}>Adapter</code>{' '}
                    interface and ships its own <code style={{ fontFamily: 'var(--mono)' }}>verifyCredentials()</code>.
                  </p>
                </div>
                <div className="arrow">
                  <span>↓</span>
                </div>
                <div className="layer">
                  <b>Platform APIs</b>
                  <p>Telegram, Meta, LINE, Twilio, Google, Microsoft, AWS, Firebase and the rest.</p>
                </div>
              </div>
            </Reveal>
          </div>
        </section>

        {/* ---------------- cta ---------------- */}
        <section id="install">
          <div className="wrap">
            <Reveal>
              <div className="card" style={{ padding: '46px 40px', textAlign: 'center' }}>
                <p className="eyebrow" style={{ marginBottom: 8 }}>
                  Install
                </p>
                <h2>Ship your first channel today.</h2>
                <p className="lede" style={{ margin: '14px auto 26px' }}>
                  Install only the channels you need. Everything is MIT licensed and TypeScript-native.
                </p>
                <div style={{ maxWidth: 660, margin: '0 auto', textAlign: 'left' }}>
                  <CodeBlock code="npm install @msgly/core @msgly/whatsapp @msgly/telegram @msgly/twilio-sms" />
                </div>
                <div className="hero-cta" style={{ justifyContent: 'center', marginTop: 26 }}>
                  <a className="btn primary" href={REPO} target="_blank" rel="noreferrer">
                    Read the docs on GitHub
                  </a>
                  <a className="btn" href={`${REPO}/issues`} target="_blank" rel="noreferrer">
                    Report an issue
                  </a>
                </div>
              </div>
            </Reveal>
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
              {' · '}
              <a href={`${REPO}/blob/main/LICENSE`} target="_blank" rel="noreferrer">
                Licence
              </a>
            </span>
          </div>
        </footer>
      </main>
    </>
  );
}
