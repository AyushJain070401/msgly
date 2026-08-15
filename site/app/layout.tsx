import type { Metadata } from 'next';
import ScrollProgress from './components/ScrollProgress';
import './globals.css';

const SITE_URL = 'https://ayushjain070401.github.io/msgly/';

export const metadata: Metadata = {
  metadataBase: new URL(SITE_URL),
  alternates: { canonical: SITE_URL },
  title: 'Msgly — one API for every messaging channel',
  description:
    'Unified TypeScript messaging library for WhatsApp, Telegram, Slack, Teams, Discord, LINE, WeChat, Viber, Gmail, Outlook, SMTP, Resend, SendGrid, SES, Twilio, MSG91, Vonage, Plivo, Telnyx and FCM. Chat, email, SMS, push and voice in one interface.',
  openGraph: {
    title: 'Msgly — one API for every messaging channel',
    description: 'Chat, email, SMS, push and voice behind a single TypeScript interface.',
    type: 'website',
    url: SITE_URL,
  },
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <div className="aurora" aria-hidden>
          <span />
          <span />
          <span />
        </div>
        <div className="grid-lines" aria-hidden />
        <div className="noise" aria-hidden />
        <ScrollProgress />
        {children}
      </body>
    </html>
  );
}
