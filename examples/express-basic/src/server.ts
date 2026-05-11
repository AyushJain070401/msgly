import express, { type Request } from 'express';
import { createHub } from '@msgly/core';
import { createTelegramAdapter } from '@msgly/telegram';
import { createLineAdapter } from '@msgly/line';
import { createMessengerAdapter } from '@msgly/messenger';
import { createInstagramAdapter } from '@msgly/instagram';
import { createWhatsAppAdapter } from '@msgly/whatsapp';
import { createDiscordAdapter } from '@msgly/discord';
import { createMsTeamsAdapter } from '@msgly/msteams';
import { createGmailAdapter } from '@msgly/gmail';
import { createOutlookAdapter } from '@msgly/outlook';

const app = express();

// CRITICAL: capture the raw body before any JSON parser touches it.
// Webhook signature verification needs the exact bytes the platform sent.
app.use(
  express.json({
    verify: (req, _res, buf) => {
      (req as Request & { rawBody?: Uint8Array }).rawBody = new Uint8Array(buf);
    },
  }),
);

const hub = createHub();

// Each adapter is opt-in: register only those whose env vars are set.
// This lets you connect channels one at a time as you get credentials.

if (process.env.TELEGRAM_BOT_TOKEN) {
  hub.register(
    createTelegramAdapter({
      botToken: process.env.TELEGRAM_BOT_TOKEN,
      webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
    }),
  );
}

if (process.env.LINE_CHANNEL_ACCESS_TOKEN && process.env.LINE_CHANNEL_SECRET) {
  hub.register(
    createLineAdapter({
      channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN,
      channelSecret: process.env.LINE_CHANNEL_SECRET,
    }),
  );
}

if (process.env.MESSENGER_PAGE_TOKEN && process.env.META_APP_SECRET) {
  hub.register(
    createMessengerAdapter({
      pageAccessToken: process.env.MESSENGER_PAGE_TOKEN,
      appSecret: process.env.META_APP_SECRET,
      verifyToken: process.env.META_VERIFY_TOKEN ?? 'verify-me',
    }),
  );
}

if (process.env.INSTAGRAM_PAGE_TOKEN && process.env.META_APP_SECRET) {
  hub.register(
    createInstagramAdapter({
      pageAccessToken: process.env.INSTAGRAM_PAGE_TOKEN,
      appSecret: process.env.META_APP_SECRET,
      verifyToken: process.env.META_VERIFY_TOKEN ?? 'verify-me',
    }),
  );
}

if (
  process.env.WHATSAPP_PHONE_NUMBER_ID &&
  process.env.WHATSAPP_ACCESS_TOKEN &&
  process.env.META_APP_SECRET
) {
  hub.register(
    createWhatsAppAdapter({
      phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID,
      accessToken: process.env.WHATSAPP_ACCESS_TOKEN,
      appSecret: process.env.META_APP_SECRET,
      verifyToken: process.env.META_VERIFY_TOKEN ?? 'verify-me',
    }),
  );
}

if (
  process.env.DISCORD_APPLICATION_ID &&
  process.env.DISCORD_BOT_TOKEN &&
  process.env.DISCORD_PUBLIC_KEY
) {
  hub.register(
    createDiscordAdapter({
      applicationId: process.env.DISCORD_APPLICATION_ID,
      botToken: process.env.DISCORD_BOT_TOKEN,
      publicKey: process.env.DISCORD_PUBLIC_KEY,
    }),
  );
}

if (process.env.MSTEAMS_APP_ID && process.env.MSTEAMS_APP_PASSWORD) {
  hub.register(
    createMsTeamsAdapter({
      appId: process.env.MSTEAMS_APP_ID,
      appPassword: process.env.MSTEAMS_APP_PASSWORD,
    }),
  );
}

if (
  process.env.GMAIL_CLIENT_ID &&
  process.env.GMAIL_CLIENT_SECRET &&
  process.env.GMAIL_REFRESH_TOKEN &&
  process.env.GMAIL_EMAIL
) {
  hub.register(
    createGmailAdapter({
      clientId: process.env.GMAIL_CLIENT_ID,
      clientSecret: process.env.GMAIL_CLIENT_SECRET,
      refreshToken: process.env.GMAIL_REFRESH_TOKEN,
      emailAddress: process.env.GMAIL_EMAIL,
      pushAuth: process.env.GMAIL_PUSH_TOKEN
        ? { kind: 'token', token: process.env.GMAIL_PUSH_TOKEN }
        : { kind: 'none' },
    }),
  );
}

if (
  process.env.OUTLOOK_CLIENT_ID &&
  process.env.OUTLOOK_CLIENT_SECRET &&
  process.env.OUTLOOK_REFRESH_TOKEN &&
  process.env.OUTLOOK_EMAIL &&
  process.env.OUTLOOK_CLIENT_STATE
) {
  hub.register(
    createOutlookAdapter({
      clientId: process.env.OUTLOOK_CLIENT_ID,
      clientSecret: process.env.OUTLOOK_CLIENT_SECRET,
      refreshToken: process.env.OUTLOOK_REFRESH_TOKEN,
      emailAddress: process.env.OUTLOOK_EMAIL,
      clientState: process.env.OUTLOOK_CLIENT_STATE,
      tenantId: process.env.OUTLOOK_TENANT_ID,
    }),
  );
}

// Listen for incoming messages from any channel
hub.on('message', async (msg) => {
  console.log(
    `[${msg.channel}] ${msg.contact.displayName ?? msg.contact.channelUserId}:`,
    msg.content,
  );

  if (msg.content.type === 'text') {
    // Channels that need per-message routing context have to thread it through:
    //  - LINE uses replyToken (free reply window)
    //  - Discord uses interactionToken (PATCH the deferred ack)
    //  - Microsoft Teams uses serviceUrl (regional Connector endpoint)
    //  - Gmail uses threadId / messageId / subject / references (RFC 5322)
    //  - Outlook uses messageId (Graph routes to /messages/{id}/reply)
    const metadata: Record<string, unknown> = {};
    if (msg.metadata?.replyToken) metadata.replyToken = msg.metadata.replyToken;
    if (msg.metadata?.interactionToken) {
      metadata.interactionToken = msg.metadata.interactionToken;
    }
    if (msg.metadata?.serviceUrl) metadata.serviceUrl = msg.metadata.serviceUrl;
    if (msg.metadata?.threadId) metadata.threadId = msg.metadata.threadId;
    if (msg.metadata?.messageId) metadata.messageId = msg.metadata.messageId;
    if (msg.metadata?.subject) metadata.subject = msg.metadata.subject;
    if (msg.metadata?.references) metadata.references = msg.metadata.references;

    try {
      await hub.send({
        channel: msg.channel,
        account: msg.account,
        contact: msg.contact,
        content: { type: 'text', text: `You said: ${msg.content.text}` },
        ...(Object.keys(metadata).length > 0 ? { metadata } : {}),
      });
    } catch (err) {
      console.error('Send failed:', err instanceof Error ? err.message : err);
    }
  }
});

hub.on('delivery', (receipt) => {
  console.log(`[delivery] ${receipt.status} for ${receipt.messageId}`);
});

hub.on('error', (err, ctx) => {
  console.error('Hub error:', err.message, ctx);
});

// Wire all five channels with ONE webhook handler — generated by the hub.
const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.get('/health', (_req, res) => res.json({ ok: true, channels: hub.channels }));

const port = Number(process.env.PORT ?? 3000);

async function main(): Promise<void> {
  if (hub.channels.length === 0) {
    console.error(
      '\nNo channels are configured.\n\n' +
        'The example registers each adapter only if its env vars are set.\n' +
        'Copy .env.example to .env and fill in credentials for at least one channel.\n\n' +
        'Expected env vars (any one set is enough):\n' +
        '  - TELEGRAM_BOT_TOKEN\n' +
        '  - LINE_CHANNEL_ACCESS_TOKEN + LINE_CHANNEL_SECRET\n' +
        '  - MESSENGER_PAGE_TOKEN + META_APP_SECRET\n' +
        '  - INSTAGRAM_PAGE_TOKEN + META_APP_SECRET\n' +
        '  - WHATSAPP_PHONE_NUMBER_ID + WHATSAPP_ACCESS_TOKEN + META_APP_SECRET\n' +
        '  - DISCORD_APPLICATION_ID + DISCORD_BOT_TOKEN + DISCORD_PUBLIC_KEY\n' +
        '  - MSTEAMS_APP_ID + MSTEAMS_APP_PASSWORD\n' +
        '  - GMAIL_CLIENT_ID + GMAIL_CLIENT_SECRET + GMAIL_REFRESH_TOKEN + GMAIL_EMAIL\n' +
        '  - OUTLOOK_CLIENT_ID + OUTLOOK_CLIENT_SECRET + OUTLOOK_REFRESH_TOKEN + OUTLOOK_EMAIL + OUTLOOK_CLIENT_STATE\n',
    );
    process.exit(1);
  }

  console.log('\n→ Verifying credentials for every registered channel...\n');
  const report = await hub.connect();
  for (const [channel, result] of Object.entries(report)) {
    if (result.ok) {
      console.log(`  ✓ ${channel.padEnd(10)} connected as ${result.accountInfo}`);
    } else {
      console.log(`  ✗ ${channel.padEnd(10)} FAILED — ${result.reason}`);
      console.log(`    ${result.hint}`);
    }
  }

  const failedCount = Object.values(report).filter((r) => !r.ok).length;
  const total = Object.keys(report).length;
  if (failedCount === total) {
    console.error(
      '\nNo channels connected successfully. Fix the credentials above and restart.\n',
    );
    process.exit(1);
  }
  if (failedCount > 0) {
    console.warn(
      `\n${failedCount}/${total} channel(s) failed credentials check — they will not be available until restart.\n`,
    );
  }

  app.listen(port, () => {
    console.log(`\n→ Server listening on http://localhost:${port}`);
    console.log(`  Webhook URL pattern: http://localhost:${port}/webhook/<channel>`);
    console.log(`  Health check: http://localhost:${port}/health\n`);
  });
}

main().catch((err) => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
