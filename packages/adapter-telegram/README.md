# @msgly/telegram

> Telegram Bot API adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive Telegram messages through the unified hub — text, media, location, inline buttons, quick replies, reactions, typing indicators. **Zero classes, runs in Node, Next.js, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/telegram
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createTelegramAdapter } from '@msgly/telegram';

const hub = createHub();

hub.register(
  createTelegramAdapter({
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: 'telegram',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
    });
  }
});

const app = express();
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Config

```typescript
interface TelegramConfig {
  /** Bot token from @BotFather (required). */
  botToken: string;

  /**
   * Optional secret token echoed back by Telegram in the
   * `X-Telegram-Bot-Api-Secret-Token` header on every webhook delivery.
   * Strongly recommended in production — without it, anyone who guesses
   * your webhook URL can POST fake updates.
   */
  webhookSecret?: string;

  /** Override the API base. Defaults to https://api.telegram.org. */
  apiBase?: string;
}
```

## Setup (5 minutes)

1. In Telegram, message [@BotFather](https://t.me/BotFather) and send `/newbot`.
2. Choose a name (any) and a username ending in `bot`. Copy the token BotFather replies with.
3. Set environment variables:
   ```bash
   TELEGRAM_BOT_TOKEN=123456789:ABCDEF...
   TELEGRAM_WEBHOOK_SECRET=any-random-string
   ```
4. Register your webhook. With a public HTTPS endpoint at `<PUBLIC_URL>` (use ngrok or Cloudflare Tunnel locally):

   ```bash
   curl "https://api.telegram.org/bot$TELEGRAM_BOT_TOKEN/setWebhook?url=<PUBLIC_URL>/webhook/telegram&secret_token=$TELEGRAM_WEBHOOK_SECRET"
   ```

   Or programmatically — the adapter exposes a helper:

   ```typescript
   const adapter = createTelegramAdapter({ botToken, webhookSecret });
   hub.register(adapter);
   await adapter.setWebhook('https://my-app.example.com/webhook/telegram');
   ```

5. Test by messaging your bot in Telegram. You'll see the inbound message arrive on `hub.on('message', ...)`.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image         | ✓         |
| video         | ✓         |
| audio         | ✓         |
| file          | ✓         |
| location      | ✓         |
| buttons       | ✓         |
| quick replies | ✓         |
| reactions     | ✓         |
| typing        | ✓         |
| templates     | —         |

## Sending examples

### Image with caption

```typescript
await hub.send({
  channel: 'telegram',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/cat.png' },
    caption: 'meow',
  },
});
```

### Inline buttons

```typescript
await hub.send({
  channel: 'telegram',
  account, contact,
  content: {
    type: 'interactive',
    text: 'Pick one:',
    buttons: [
      { id: 'yes', label: 'Yes' },
      { id: 'no',  label: 'No' },
    ],
  },
});
```

When the user taps a button, your `hub.on('message', ...)` handler receives a text message whose `content.text` matches the button's `id`.

### Location

```typescript
await hub.send({
  channel: 'telegram',
  account, contact,
  content: { type: 'location', latitude: 37.7749, longitude: -122.4194, name: 'SF' },
});
```

### Downloading a media attachment

```typescript
const adapter = hub.getAdapter('telegram');
const file = await adapter.downloadMedia({ kind: 'platform-id', value: msg.content.mediaRef.value });
// file.data is a Uint8Array
```

## Common pitfalls

- **Webhook not firing**: confirm registration with `curl https://api.telegram.org/bot${TOKEN}/getWebhookInfo`. Look at `last_error_message` and `pending_update_count`.
- **`{"ok":false,"description":"Wrong response from the webhook"}`**: your server isn't returning 200 in time. The hub returns 200 only after it processes the body — keep your `hub.on('message')` handler fast or move work into a queue.
- **Webhook signature rejected**: if you set `TELEGRAM_WEBHOOK_SECRET`, you must also pass `secret_token=...` in the `setWebhook` URL. Mismatched values cause `InvalidSignature`.
- **ngrok URL keeps changing**: free ngrok rotates the URL on each restart. After ngrok restarts, you must re-run `setWebhook` with the new URL.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
