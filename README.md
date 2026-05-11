# Chatterbox

> Unified messaging library for WhatsApp, Instagram, Messenger, Telegram, and LINE. One API, every channel.

[![CI](https://github.com/AyushJain070401/chatterbox/actions/workflows/ci.yml/badge.svg)](https://github.com/AyushJain070401/chatterbox/actions)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)

## Why

Building a chatbot or notification system that works across multiple channels means learning five different APIs, five webhook formats, five different media-handling rules. Chatterbox collapses that into one TypeScript-native interface: register the adapters you need, send and receive in a single unified format.

## Status

| Channel    | Package                          | Status     | Tests |
| ---------- | -------------------------------- | ---------- | ----- |
| Telegram   | `@chatterbox/telegram`        | Implemented | 7/7 |
| LINE       | `@chatterbox/line`            | Implemented | 7/7 |
| Messenger  | `@chatterbox/messenger`       | Implemented | 7/7 |
| Instagram  | `@chatterbox/instagram`       | Implemented | 3/3 |
| WhatsApp   | `@chatterbox/whatsapp`        | Implemented | 9/9 |
| Core engine | `@chatterbox/core`           | Implemented | 12/12 |

**45 tests across 6 packages, all passing. 0 type errors.**

## 60-second quickstart

If you've never used this library before, do this first. It uses Telegram (the easiest channel — no business verification, no Meta App, no Pages) to get you to "it works" before introducing anything complex.

**What you need:** Node.js 18 or newer, and a Telegram account.

**1. Get the code and install:**

```bash
unzip chatterbox.zip
cd chatterbox
pnpm install
pnpm build
```

**2. Get a Telegram bot token (1 minute):**

- Open Telegram, search for **@BotFather**, start a chat
- Send: `/newbot`
- Choose a name (anything) and a username ending in `bot`
- BotFather replies with a token like `123456789:ABC-DEF...` — copy it

**3. Set up the example env file:**

```bash
cd examples/express-basic
cp .env.example .env
```

Open `.env` and set these two lines:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABC-DEF...    # your BotFather token
TELEGRAM_WEBHOOK_SECRET=any-random-string  # invent any value
```

**4. Start the server:**

```bash
pnpm start
```

You should see:

```
→ Verifying credentials for every registered channel...

  ✓ telegram   connected as @my_test_bot
  ✗ whatsapp   FAILED — unauthorized
    WhatsApp rejected the access token. If you used the temporary token,
    it expires after 24h — generate a new one or set up a permanent System
    User token.

→ Server listening on http://localhost:3000
```

Every failure has an actionable hint telling you exactly what to fix and where to find it. If you only configured Telegram you'll see just the one `✓ telegram` line.

**5. Expose your server to the internet** (so Telegram can reach it). In a separate terminal:

```bash
# Install ngrok if you don't have it: https://ngrok.com/download
ngrok http 3000
```

ngrok prints a public URL like `https://abc123.ngrok-free.app`. Copy it.

**6. Register the webhook with Telegram:**

```bash
TOKEN="123456789:ABC-DEF..."        # your bot token
SECRET="any-random-string"          # your TELEGRAM_WEBHOOK_SECRET
URL="https://abc123.ngrok-free.app" # your ngrok URL

curl "https://api.telegram.org/bot$TOKEN/setWebhook?url=$URL/webhook/telegram&secret_token=$SECRET"
```

You should see `{"ok":true,"result":true,"description":"Webhook was set"}`.

**7. Talk to your bot:** In Telegram, search for your bot by the username you set in step 2, send `hello`, and your bot replies `You said: hello`.

That's it. You have a working chatbot built on Chatterbox.

### What to do next

- **Add another channel**: see the [Connection guide](#connection-guide) below, pick another channel (LINE is simplest after Telegram), set its env vars in `.env`, restart the server. The webhook URL pattern is the same: `<your-public-url>/webhook/<channel>`.
- **Customize the response**: edit `examples/express-basic/src/server.ts`, find the `hub.on('message', ...)` block, change the echo logic to whatever you want.
- **Build your own app**: copy the relevant adapter wiring from the example into your own Express/NestJS/Fastify app. The whole library is ~7KB compiled.

### Common gotchas

- **`curl` returns `{"ok":false,"description":"Wrong response from the webhook"}`**: your server isn't running, or ngrok crashed. Re-check both.
- **Bot doesn't reply but logs show inbound message**: usually a send error — check the server console for the actual API error message.
- **"Channels are not configured"**: the env var names must match exactly. `TELEGRAM_BOT_TOKEN`, not `TELEGRAM_TOKEN`.
- **ngrok URL keeps changing**: free ngrok rotates the URL on each restart. After ngrok restarts, you must re-run the `setWebhook` curl with the new URL.

## Install (production)

```bash
# Install only the channels you need
npm install @chatterbox/core @chatterbox/whatsapp @chatterbox/telegram
```

## Quick start (multi-channel echo bot)

```typescript
import express from 'express';
import { MessagingHub } from '@chatterbox/core';
import { TelegramAdapter } from '@chatterbox/telegram';
import { WhatsAppAdapter } from '@chatterbox/whatsapp';

const hub = new MessagingHub();

hub.register(new TelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
}));

hub.register(new WhatsAppAdapter({
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
      content: { type: 'text', text: `You said: ${msg.content.text}` },
    });
  }
});

const app = express();
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = buf) }));

// One built-in handler for all channels: GET (Meta handshake) + POST (dispatch)
const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Features in detail

### Startup credentials check

```typescript
const report = await hub.connect();
// { telegram: { ok: true, accountInfo: '@my_bot' },
//   whatsapp: { ok: false, reason: 'unauthorized', hint: '...' } }

// Or fail-fast for boot scripts:
await hub.connect({ throwOnFailure: true });
```

Every adapter ships a `verifyCredentials()` that calls the platform's whoami endpoint and returns either confirmation or a precise hint (which env var, where to find it, how to regenerate).

### Built-in webhook handler

`hub.createWebhookHandler()` returns `{ get, post }` for any Express-like framework. It handles:

- Meta-family GET subscription handshake (`hub.verify_token` check)
- POST signature verification (HMAC-SHA256 per platform)
- Channel dispatch via the `:channel` route param
- Idempotency (duplicate webhooks deduplicated by externalId)

### Smart retry

Sends are wrapped in exponential-backoff retry with equal jitter. The hub distinguishes retryable (network errors, 5xx) from non-retryable (401/403/404 — your token is bad, retrying won't fix it):

```typescript
const hub = new MessagingHub({
  retry: { maxAttempts: 5, initialDelayMs: 200, maxDelayMs: 4000 },
});
```

### Capability checks

The hub validates every send against the target channel's capabilities and throws `UnsupportedFeatureError` if you try to send something a channel can't handle:

```typescript
import { UnsupportedFeatureError } from '@chatterbox/core';

try {
  await hub.send({
    channel: 'instagram',
    // ...
    content: { type: 'audio', mediaRef: { kind: 'url', value: '...' } },
  });
} catch (err) {
  if (err instanceof UnsupportedFeatureError) {
    console.log('Instagram does not support audio sends');
  }
}
```

### Platform limits enforced

LINE quick-replies, Messenger quick-replies, and WhatsApp interactive buttons all have platform-specific maxes on count and label length. The adapters silently truncate to fit instead of failing with cryptic API errors.

## Sending a WhatsApp template (outside the 24h window)

```typescript
await hub.send({
  channel: 'whatsapp',
  account: { channel: 'whatsapp', channelAccountId: process.env.WA_PHONE_ID! },
  contact: { channel: 'whatsapp', channelUserId: '919999999999' },
  content: {
    type: 'template',
    templateName: 'order_confirmation',
    language: 'en',
    variables: { '1': 'Udesh', '2': 'ORDER-12345' },
  },
});
```

## Replying to a LINE message with the free reply token

```typescript
hub.on('message', async (msg) => {
  if (msg.channel === 'line' && msg.content.type === 'text') {
    await hub.send({
      channel: 'line',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: 'thanks!' },
      metadata: { replyToken: msg.metadata?.replyToken },
    });
  }
});
```

## Connecting Telegram programmatically

No need to hand-craft a curl command:

```typescript
const adapter = new TelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
});
hub.register(adapter);
await adapter.setWebhook('https://my-app.example.com/webhook/telegram');
```

## Connection guide

Step-by-step instructions to get each channel connected. Skip the channels you don't need.

> **Tip**: Every adapter exposes `verifyCredentials()`. The example server calls `hub.connect()` on startup which runs this for every registered adapter and prints a precise hint for whatever's wrong. If something doesn't work, run the example and read the error.

### Prerequisites for local development

You need a public HTTPS URL for incoming webhooks. The simplest options:

- **ngrok**: `npm install -g ngrok` then `ngrok http 3000` (free for development)
- **Cloudflare Tunnel**: `cloudflared tunnel --url http://localhost:3000` (also free)

Both give you a `https://<random>.ngrok-free.app` (or similar) URL. That's your **public webhook base** — replace `<PUBLIC_URL>` below with that.

### Telegram (5 minutes — the easiest)

**1. Get your bot token.** In Telegram, message [@BotFather](https://t.me/BotFather):

```
/newbot
```

Give it a name (e.g. "My Hub Bot") and a username (must end in `bot`). BotFather replies with a token like `123456789:ABCDEF...`.

**2. Set it in `.env`**:

```bash
TELEGRAM_BOT_TOKEN=123456789:ABCDEF...
TELEGRAM_WEBHOOK_SECRET=any-random-string-you-pick
```

**3. Start your server** (`pnpm --filter express-basic start`).

**4. Register the webhook.** With your `PUBLIC_URL` from ngrok:

```bash
curl "https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/setWebhook?url=${PUBLIC_URL}/webhook/telegram&secret_token=${TELEGRAM_WEBHOOK_SECRET}"
```

Or programmatically (one-liner script):

```typescript
import { TelegramAdapter } from '@chatterbox/telegram';
const adapter = new TelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
});
await adapter.setWebhook(`${process.env.PUBLIC_URL}/webhook/telegram`);
```

**5. Test it.** In Telegram, find your bot by username and send "hello". You should see the echo reply.

### LINE (10 minutes)

**1. Create a channel.** Sign up at [developers.line.biz](https://developers.line.biz), create a Provider, then create a **Messaging API channel** inside it.

**2. Get the credentials.**

- Open your channel → **Basic settings** tab → copy **Channel secret** → set as `LINE_CHANNEL_SECRET`
- Switch to **Messaging API** tab → click **Issue** under "Channel access token (long-lived)" → copy → set as `LINE_CHANNEL_ACCESS_TOKEN`

**3. Set the webhook URL.** Still on the **Messaging API** tab:

- Webhook URL: `<PUBLIC_URL>/webhook/line`
- Toggle **Use webhook** to ON
- Click **Verify** — should succeed

**4. Disable greeting and auto-reply.** On the same tab:

- "Auto-reply messages": OFF (otherwise LINE answers before your bot does)
- "Greeting messages": OFF (optional)

**5. Add the bot to a chat.** Find the bot's QR code on the **Messaging API** tab → scan with the LINE app → add as friend → message it.

### Meta — Set up the parent App once (used by Messenger / Instagram / WhatsApp)

You need ONE Meta App that holds all three Meta channels.

**1. Create the App.** [developers.facebook.com](https://developers.facebook.com) → **My Apps** → **Create App** → choose **Business** type.

**2. Get App Secret.** Settings → Basic → click **Show** next to **App Secret** → set as `META_APP_SECRET`.

**3. Pick a verify token.** This is YOUR chosen string. Any random string works — just use the same value in code AND in Meta's webhook subscription form. Set as `META_VERIFY_TOKEN`.

### Messenger (15 minutes — needs a Facebook Page)

**Prerequisite**: You need a Facebook Page. Create one at [facebook.com/pages/create](https://facebook.com/pages/create) if you don't have one.

**1. Add the Messenger product.** In your Meta App → **Add Product** → **Messenger** → **Set up**.

**2. Generate a page token.**

- Messenger → **Settings** → "Generate Tokens" section → select your Page → click **Generate Token**
- A long token appears once — copy it immediately
- Set as `MESSENGER_PAGE_TOKEN`

**3. Subscribe to the webhook.** Same Settings page, "Webhooks" section:

- Callback URL: `<PUBLIC_URL>/webhook/messenger`
- Verify token: the value of `META_VERIFY_TOKEN`
- Click **Verify and Save** — your server must be running so the GET handshake succeeds
- Subscription fields: tick `messages`, `messaging_postbacks`

**4. Subscribe the Page.** "Webhooks" section → next to your Page → click **Subscribe**.

**5. Test.** Open Messenger, find your Page, send a message.

> **Token expiry note**: page tokens generated in the dashboard are short-lived in development mode. For production, exchange for a long-lived token using `/oauth/access_token?grant_type=fb_exchange_token`, OR move the App to "Live" mode and use a System User token from Business Settings.

### Instagram (15 minutes — needs Business IG account)

**Prerequisites**:

1. An **Instagram Business** or **Creator** account (in the Instagram app: Settings → Account → Switch to Professional Account)
2. The Facebook Page from the Messenger setup, **linked to your Instagram Business account** (Page Settings → Linked Accounts → Instagram)

**1. Add Instagram messaging.** In your Meta App → **Messenger** product → **Instagram Settings** tab → click **Add or Remove Pages** → tick the Page that's linked to your IG account.

**2. Generate the IG-enabled token.** Same Instagram Settings tab → Generate Token. Set as `INSTAGRAM_PAGE_TOKEN`.

**3. Subscribe webhooks.** Webhooks section on the Instagram Settings tab:

- Callback URL: `<PUBLIC_URL>/webhook/instagram`
- Verify token: same `META_VERIFY_TOKEN`
- Subscribe to `messages`

**4. Allow message access on the IG side.** In the Instagram app: Settings → Privacy → Messages → "Allow access to messages" — must be ON.

**5. Test.** From a different IG account, send your Business account a DM.

### WhatsApp Cloud API (20 minutes)

**1. Add the WhatsApp product.** In your Meta App → **Add Product** → **WhatsApp** → **Set up**.

**2. Get test credentials.** **API Setup** tab. Meta provides a free test number. From this page, copy:

- "Phone number ID" (the long numeric one — NOT the human-readable phone) → `WHATSAPP_PHONE_NUMBER_ID`
- "Temporary access token" (24h) → `WHATSAPP_ACCESS_TOKEN`

> The temporary token expires every 24 hours. For anything past testing, set up a permanent token: Business Settings → Users → System Users → create one → Generate Token (with `whatsapp_business_messaging` and `whatsapp_business_management` scopes).

**3. Add a recipient phone.** Same API Setup page → "To" dropdown → "Manage phone number list" → add YOUR personal WhatsApp number (test mode allows up to 5 numbers without business verification).

**4. Subscribe the webhook.** **Configuration** tab (in WhatsApp menu):

- Callback URL: `<PUBLIC_URL>/webhook/whatsapp`
- Verify token: `META_VERIFY_TOKEN`
- Click **Verify and Save**
- Webhook fields → Subscribe to `messages`

**5. Test.** From your personal WhatsApp, send a message to the test number from API Setup. The example bot will echo back.

> **24-hour window**: free-form replies (text, media) only work within 24h of an inbound user message. Outside that window you must send a pre-approved **template** (`content: { type: 'template', templateName, language, variables }`). Templates are created and approved in Meta dashboard → WhatsApp → Message Templates.

### Did something go wrong?

#### "Credentials check failed" at startup

Run the example with `pnpm --filter express-basic start` — it prints exact remediation hints for each failed channel. The hint tells you which env var, where to find the value, and how to regenerate it.

#### "Invalid signature" on incoming webhooks

Three things to check:

1. Did you set the right secret? `META_APP_SECRET` for Meta channels, `LINE_CHANNEL_SECRET` for LINE, `TELEGRAM_WEBHOOK_SECRET` for Telegram.
2. Is your Express app capturing the **raw body** before the JSON parser? See `src/server.ts` — the `verify` callback in `express.json()` is essential.
3. For Telegram only: did you pass `secret_token` when calling `setWebhook`? It must match `TELEGRAM_WEBHOOK_SECRET`.

#### "Webhook verify failed" during Meta subscription

The GET handshake checks `hub.verify_token` against your `META_VERIFY_TOKEN`. They must be byte-identical. Also: your server must be reachable at the public URL **at the moment you click Verify** in the Meta dashboard.

#### My bot replies but the user doesn't see it

- Telegram: confirm webhook is set with `curl https://api.telegram.org/bot${TOKEN}/getWebhookInfo`
- LINE: in the LINE Developers Console, make sure "Auto-reply messages" is **OFF** — it overrides bot responses
- Messenger: app must be subscribed to the Page (Webhooks → Subscribe next to the Page)
- WhatsApp: the recipient must be in your test number list during development

## Architecture

Three layers, defined by clean contracts:

```
Developer's app
       ↓
@chatterbox/core   ←  unified types, MessagingHub orchestrator,
       ↓                  retry, idempotency, capability checks
Channel adapters       ←  one package per platform, each implements Adapter,
       ↓                  each ships its own verifyCredentials()
Platform APIs (Telegram, Meta, LINE)
```

Every adapter implements the same `Adapter` abstract class. Adding a sixth channel is one new package — no core changes needed.

## Development

```bash
pnpm install
pnpm build
pnpm test
```

## License

MIT
