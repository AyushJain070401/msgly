export type Channel = {
  name: string;
  pkg: string;
  category: 'Chat & social' | 'Email' | 'SMS & voice' | 'Push' | 'Publishing' | 'Core';
  notes: string;
  campaign: 'Outbound' | 'Broadcast' | 'Policy-gated' | 'Reply-only' | 'Not for campaigns' | '—';
};

export const channels: Channel[] = [
  { name: 'Telegram', pkg: '@msgly/telegram', category: 'Chat & social', notes: 'Bot API, inline keyboards, and channel posting via @name', campaign: 'Broadcast' },
  { name: 'WhatsApp', pkg: '@msgly/whatsapp', category: 'Chat & social', notes: 'Cloud Business API; approved MARKETING templates for campaigns', campaign: 'Policy-gated' },
  { name: 'Messenger', pkg: '@msgly/messenger', category: 'Chat & social', notes: 'Meta Send API, plus publishPost() to the Page feed', campaign: 'Broadcast' },
  { name: 'Instagram', pkg: '@msgly/instagram', category: 'Chat & social', notes: 'Direct messages, plus publishPost() for feed posts and Reels', campaign: 'Broadcast' },
  { name: 'LINE', pkg: '@msgly/line', category: 'Chat & social', notes: 'broadcast() to all friends, multicast() to a segment', campaign: 'Broadcast' },
  { name: 'Discord', pkg: '@msgly/discord', category: 'Chat & social', notes: 'HTTP Interactions with buttons and message components', campaign: 'Not for campaigns' },
  { name: 'Microsoft Teams', pkg: '@msgly/msteams', category: 'Chat & social', notes: 'Bot Framework channel with Adaptive Card support', campaign: 'Not for campaigns' },
  { name: 'Slack', pkg: '@msgly/slack', category: 'Chat & social', notes: 'Events API and Block Kit; posts to a channel, not to users', campaign: 'Not for campaigns' },
  { name: 'WeChat', pkg: '@msgly/wechat', category: 'Chat & social', notes: 'massSend() to all followers or a tag group, quota-metered', campaign: 'Broadcast' },
  { name: 'Viber', pkg: '@msgly/viber', category: 'Chat & social', notes: 'broadcast() to up to 300 subscribers per call', campaign: 'Broadcast' },
  { name: 'Mattermost', pkg: '@msgly/mattermost', category: 'Chat & social', notes: 'Self-hosted chat over REST and outgoing webhooks', campaign: 'Not for campaigns' },
  { name: 'Rocket.Chat', pkg: '@msgly/rocketchat', category: 'Chat & social', notes: 'Self-hosted chat via REST plus outgoing webhooks', campaign: 'Not for campaigns' },
  { name: 'Google Chat', pkg: '@msgly/googlechat', category: 'Chat & social', notes: 'Service-account auth with Google-signed webhooks', campaign: 'Not for campaigns' },

  { name: 'Gmail', pkg: '@msgly/gmail', category: 'Email', notes: 'Pub/Sub push delivery and MIME attachment handling', campaign: '—' },
  { name: 'Outlook / M365', pkg: '@msgly/outlook', category: 'Email', notes: 'Graph change notifications and attachment handling', campaign: '—' },
  { name: 'SMTP / IMAP', pkg: '@msgly/smtp', category: 'Email', notes: 'Yahoo, Zoho, Fastmail or any custom mail server', campaign: 'Outbound' },
  { name: 'Resend', pkg: '@msgly/resend', category: 'Email', notes: 'Transactional email over HTTP, Edge-compatible', campaign: 'Outbound' },
  { name: 'Mailgun', pkg: '@msgly/mailgun', category: 'Email', notes: 'Transactional email, inbound routes and signed event webhooks', campaign: 'Outbound' },
  { name: 'Postmark', pkg: '@msgly/postmark', category: 'Email', notes: 'Transactional email with message streams and bounce webhooks', campaign: 'Outbound' },
  { name: 'SendGrid', pkg: '@msgly/sendgrid', category: 'Email', notes: 'Inbound Parse and ECDSA-signed event webhooks', campaign: 'Outbound' },
  { name: 'Amazon SES', pkg: '@msgly/ses', category: 'Email', notes: 'High-volume email, SigV4 with SNS bounce handling', campaign: 'Outbound' },

  { name: 'Twilio SMS', pkg: '@msgly/twilio-sms', category: 'SMS & voice', notes: 'SMS and MMS, with media attachments and receipts', campaign: 'Outbound' },
  { name: 'Exotel', pkg: '@msgly/exotel', category: 'SMS & voice', notes: 'India-focused SMS with DLT template compliance', campaign: 'Outbound' },
  { name: 'MSG91', pkg: '@msgly/msg91', category: 'SMS & voice', notes: 'India SMS through the DLT Flow API, template-first', campaign: 'Outbound' },
  { name: 'Vonage', pkg: '@msgly/vonage-sms', category: 'SMS & voice', notes: 'Global SMS delivery with signed inbound webhooks', campaign: 'Outbound' },
  { name: 'Plivo', pkg: '@msgly/plivo', category: 'SMS & voice', notes: 'Global SMS and MMS with V3 signature verification', campaign: 'Outbound' },
  { name: 'Telnyx', pkg: '@msgly/telnyx', category: 'SMS & voice', notes: 'Global SMS and MMS, Ed25519-signed webhooks', campaign: 'Outbound' },
  { name: 'Dial', pkg: '@msgly/dial', category: 'SMS & voice', notes: 'Agent-provisioned numbers — SMS, MMS and iMessage with HMAC-signed webhooks', campaign: 'Policy-gated' },
  { name: 'Genesys SMS', pkg: '@msgly/genesys-sms', category: 'SMS & voice', notes: 'Genesys Cloud CX contact-center SMS, OAuth2 client-credentials, JSON notification webhooks', campaign: 'Not for campaigns' },
  { name: 'Twilio Voice', pkg: '@msgly/twilio-voice', category: 'SMS & voice', notes: 'TwiML flows, Gather input and outbound calls', campaign: '—' },

  { name: 'Reddit', pkg: '@msgly/reddit', category: 'Publishing', notes: 'Subreddit posts, thread replies and inbox polling', campaign: 'Broadcast' },
  { name: 'TikTok', pkg: '@msgly/tiktok', category: 'Publishing', notes: 'Video and photo publishing, comment replies and DMs', campaign: 'Broadcast' },

  { name: 'FCM', pkg: '@msgly/fcm', category: 'Push', notes: 'Push to Android, iOS and web, plus topic broadcast', campaign: 'Outbound' },
  { name: 'APNs', pkg: '@msgly/apns', category: 'Push', notes: 'Apple push direct — iOS, macOS and Safari, no Firebase in the path', campaign: 'Outbound' },
  { name: 'Web Push', pkg: '@msgly/web-push', category: 'Push', notes: 'Browser notifications over VAPID, encrypted per subscription', campaign: 'Outbound' },
  { name: 'Expo Push', pkg: '@msgly/expo-push', category: 'Push', notes: 'React Native push via Expo, with ticket and receipt tracking', campaign: 'Outbound' },
  { name: 'RCS', pkg: '@msgly/rcs-twilio', category: 'Chat & social', notes: 'Branded rich cards and suggestion chips via Twilio, with SMS fallback', campaign: 'Policy-gated' },
  { name: 'Plivo Voice', pkg: '@msgly/plivo-voice', category: 'SMS & voice', notes: 'IVR and outbound calls, sharing the Plivo SMS credentials', campaign: 'Not for campaigns' },
  { name: 'Vonage Voice', pkg: '@msgly/vonage-voice', category: 'SMS & voice', notes: 'NCCO-driven IVR and outbound calls', campaign: 'Not for campaigns' },
  { name: 'Exotel Voice', pkg: '@msgly/exotel-voice', category: 'SMS & voice', notes: 'India click-to-call and App Bazaar flow dialling', campaign: 'Not for campaigns' },
  { name: 'Genesys Voice', pkg: '@msgly/genesys-voice', category: 'SMS & voice', notes: 'Genesys Cloud CX telephony via the Conversations API — no inline IVR markup', campaign: 'Not for campaigns' },

  { name: 'Core', pkg: '@msgly/core', category: 'Core', notes: 'Hub, adapter contract, retries, storage, campaigns', campaign: '—' },
];

export const categories = ['All', 'Chat & social', 'Email', 'SMS & voice', 'Push', 'Publishing', 'Core'] as const;

export const features = [
  {
    title: 'Startup credentials check',
    file: 'boot.ts',
    body: 'Every adapter ships verifyCredentials(). hub.connect() calls the platform whoami endpoint for each channel and returns either confirmation or a precise hint — which env var, where to find it, how to regenerate.',
    code: `const report = await hub.connect();
// telegram → ok: '@my_bot'
// whatsapp → unauthorized (+ hint)

// Or fail fast when booting:
await hub.connect({
  throwOnFailure: true,
});`,
  },
  {
    title: 'One webhook handler, every channel',
    file: 'server.ts',
    body: 'hub.createWebhookHandler() returns { get, post } for any Express-like framework: Meta GET handshake, per-platform HMAC signature verification, channel dispatch and idempotent de-duplication by externalId.',
    code: `const wh = hub.createWebhookHandler();

app.get('/webhook/:channel', wh.get);
app.post('/webhook/:channel', wh.post);`,
  },
  {
    title: 'Smart retry',
    file: 'hub.ts',
    body: 'Transient failures retry with exponential backoff and jitter. Permanent failures — bad credentials, invalid recipients — fail immediately instead of burning your rate limit.',
    code: `const hub = createHub({
  retry: {
    attempts: 4,
    baseDelayMs: 250,
  },
});`,
  },
  {
    title: 'State persistence',
    file: 'hub.ts',
    body: 'Bring any KV store — Redis, DynamoDB, Cloudflare KV. The hub uses it for idempotency keys, conversation state and suppression, so restarts and multiple instances stay consistent.',
    code: `const hub = createHub({
  storage: redisStorage(redisClient),
});`,
  },
  {
    title: 'Capability checks',
    file: 'react.ts',
    body: 'Ask before you send. Channels differ on attachments, buttons, templates and reactions — msgly answers up front rather than failing at the API boundary.',
    code: `const can = hub.supports(
  'telegram', 'reaction',
);

if (can) {
  await hub.react({ /* ... */ });
}`,
  },
  {
    title: 'Platform limits enforced',
    file: 'limits.ts',
    body: 'Text length caps, attachment size and MIME restrictions are validated locally before the request goes out, so you get a clear error instead of an opaque platform rejection.',
    code: `// 4096 chars on Telegram,
// 1600 on SMS — both checked
// before the network call.
await hub.send({ /* ... */ });`,
  },
];

export const quickstart = [
  { step: '01', title: 'Install', body: 'Only the channels you actually need.', code: 'npm install @msgly/core @msgly/telegram' },
  { step: '02', title: 'Get a bot token', body: 'Message @BotFather on Telegram, send /newbot, copy the token. No business verification, no Meta App.', code: 'TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...\nTELEGRAM_WEBHOOK_SECRET=any-random-string' },
  { step: '03', title: 'Register and connect', body: 'Credentials are verified at boot, so bad tokens fail fast with an actionable hint.', code: `const hub = createHub();
hub.register(createTelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
}));
await hub.connect({ throwOnFailure: true });` },
  { step: '04', title: 'Go live', body: 'Expose port 3000 with ngrok, register the webhook URL with Telegram, and send your bot a message.', code: 'ngrok http 3000' },
];

export const echoBot = `import express from 'express';
import { createHub } from '@msgly/core';
import { createTelegramAdapter } from '@msgly/telegram';
import { createWhatsAppAdapter } from '@msgly/whatsapp';

const hub = createHub();

hub.register(createTelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
}));

hub.register(createWhatsAppAdapter({
  phoneNumberId: process.env.WA_PHONE_ID!,
  accessToken: process.env.WA_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
}));

// Verify credentials at startup — fail fast on bad tokens
await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: msg.channel,
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: \`You said: \${msg.content.text}\` },
    });
  }
});

const app = express();
const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);
app.listen(3000);`;

export const campaignCode = `const result = await hub.sendBulk({
  channel: 'whatsapp',
  account: { channel: 'whatsapp', channelAccountId: process.env.WA_PHONE_ID! },
  recipients: customers.map((c) => ({
    contact: { channel: 'whatsapp', channelUserId: c.phone },
    metadata: { crmId: c.id },
  })),
  // A function, so every recipient gets their own template variables:
  content: (r) => ({
    type: 'template',
    templateName: 'order_update',
    language: 'en_US',
    variables: { '1': nameFor(r.contact), '2': orderFor(r.contact) },
  }),
  concurrency: 8,
  onProgress: (p) => console.log(\`\${p.completed}/\${p.total}\`),
  signal: AbortSignal.timeout(60_000),
});

console.log(\`sent \${result.sent}, failed \${result.failed}\`);`;

export const suppressionCode = `import { createHub, createInMemorySuppressionStore, applyConsentIntent } from '@msgly/core';

const suppression = createInMemorySuppressionStore(); // use a KV store in production
const hub = createHub({ suppressionStore: suppression });

// Capture STOP / UNSUBSCRIBE replies automatically
hub.on('message', (msg) => applyConsentIntent(msg, suppression));

// Hard bounces and spam complaints suppress themselves
hub.on('delivery', (r) => applyDeliveryReceipt(r, 'resend', suppression));

const result = await hub.sendBulk({ /* ... */ });
console.log(result.sent, result.skipped); // skipped = opted out`;

export const campaignTiers = [
  { tier: 'Built for outbound', tone: 'good', channels: 'SES, SMTP, Resend, SendGrid, Twilio SMS, Exotel, MSG91, Vonage, Plivo, Telnyx, FCM', note: 'Email, SMS and push, fanned out per recipient. Honour opt-outs.' },
  { tier: 'Native broadcast', tone: 'good', channels: 'LINE, WeChat, Viber, Telegram, FCM topics', note: 'One API call reaches the whole audience — no per-recipient fan-out.' },
  { tier: 'Feed publishing', tone: 'good', channels: 'Instagram, Facebook Pages, Reddit, TikTok', note: 'publishPost() puts a post on the feed. No recipient, so it sits outside send().' },
  { tier: 'Policy-gated', tone: 'warn', channels: 'WhatsApp', note: 'Real campaign channel, but needs approved MARKETING templates and opt-in.' },
  { tier: 'Reply-only DMs', tone: 'warn', channels: 'Messenger, Instagram DMs', note: '24h window and message tags only — no DM marketing broadcast.' },
  { tier: 'Not campaign channels', tone: 'bad', channels: 'Slack, Teams, Discord, Mattermost, Rocket.Chat, Google Chat', note: 'The recipient is a room, not a person. Post to a channel instead.' },
];

/** Shown alongside sendBulk to make the distinction concrete. */
export const broadcastCode = `// LINE: one call reaches every friend — no fan-out, no per-recipient cost
await line.broadcast(
  { type: 'text', text: 'Sale starts now' },
  { retryKey: 'spring-sale-2026' },   // a timeout cannot double-send
);

// WeChat: all followers, or one tag group. Metered at 4/month.
await wechat.massSend({ type: 'text', text: 'New arrivals' }, { tagId: 7 });

// Viber: up to 300 subscribers per call, with per-recipient failures returned
const r = await viber.broadcast(ids, { type: 'text', text: 'Sale' });
r.metadata?.failed; // [{ id, status }] — feed these to the suppression store

// Telegram: a channel is just another chat id
await hub.send({
  channel: 'telegram',
  contact: { channel: 'telegram', channelUserId: '@acme_announcements' },
  content: { type: 'text', text: 'Shipped v2' },
  account: { channel: 'telegram', channelAccountId: 'acme_bot' },
});

// Instagram / Facebook: publishing, not messaging
await instagram.publishPost({
  imageUrl: 'https://cdn.acme.com/promo.jpg',
  caption: 'Spring sale is live',
});`;

export const REPO = 'https://github.com/AyushJain070401/msgly';
