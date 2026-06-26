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

   Or programmatically — the adapter exposes a helper. Pass `allowedUpdates` to ensure inline button taps (`callback_query`) and edited messages are delivered:

   ```typescript
   const adapter = createTelegramAdapter({ botToken, webhookSecret });
   hub.register(adapter);
   await adapter.setWebhook('https://my-app.example.com/webhook/telegram', {
     allowedUpdates: ['message', 'edited_message', 'callback_query'],
   });
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

### Formatted text (MarkdownV2)

```typescript
import { fmt } from '@msgly/telegram';

await hub.send({
  channel: 'telegram',
  account, contact,
  content: {
    type: 'text',
    format: 'markdown',   // enables parse_mode: MarkdownV2
    text: [
      fmt.bold('Order #1234 confirmed'),
      `Tracking: ${fmt.code('TRK-99887')}`,
      fmt.link('Track your parcel', 'https://track.example.com/TRK-99887'),
    ].join('\n'),
  },
});
```

Available helpers: `bold`, `italic`, `underline`, `strikethrough`, `spoiler`, `code`, `pre(text, lang?)`, `link(text, url)`, `escape`.
Use `format: 'html'` with `htmlFmt` if you prefer HTML tags (`htmlFmt.bold`, `htmlFmt.italic`, etc.).

### Inline buttons (single row)

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

When the user taps a button, your `hub.on('message', ...)` handler receives a message with `content.text` equal to the button's `id` and an `interaction` field:

```typescript
hub.on('message', async (msg) => {
  if (msg.interaction) {
    // Dismiss the loading spinner on the button (must be done within 10 s)
    const adapter = hub.getAdapter('telegram') as TelegramAdapter;
    await adapter.answerCallbackQuery(msg.interaction.id);

    console.log('button tapped:', msg.interaction.data); // the button id
  }
});
```

### Multi-row inline keyboard (2D buttons)

Pass a 2D array to lay out buttons in a grid:

```typescript
await hub.send({
  channel: 'telegram',
  account, contact,
  content: {
    type: 'interactive',
    text: 'Rate us:',
    buttons: [
      [{ id: '1', label: '⭐' }, { id: '2', label: '⭐⭐' }, { id: '3', label: '⭐⭐⭐' }],
      [{ id: '4', label: '⭐⭐⭐⭐' }, { id: '5', label: '⭐⭐⭐⭐⭐' }],
    ],
  },
});
```

### Reply keyboard (sends text into the chat)

Use `keyboardType: 'reply'` when you want button taps to send real user text through the normal AI loop (suggested prompts, quick replies):

```typescript
await hub.send({
  channel: 'telegram',
  account, contact,
  content: {
    type: 'interactive',
    text: 'What would you like help with?',
    keyboardType: 'reply',
    buttons: [
      { id: 'track', label: 'Track my order' },
      { id: 'return', label: 'Return an item' },
    ],
  },
});
```

The user sees a keyboard at the bottom; tapping a button sends that label as a regular message — no `interaction` field, just `content.text`.

### Location

```typescript
await hub.send({
  channel: 'telegram',
  account, contact,
  content: { type: 'location', latitude: 37.7749, longitude: -122.4194, name: 'SF' },
});
```

### Typing indicator

```typescript
const adapter = hub.getAdapter('telegram') as TelegramAdapter;
await adapter.sendTyping(msg.contact); // shows "typing..." in the chat
// --- do your AI work here ---
await hub.send({ channel: 'telegram', account, contact, content: { type: 'text', text: reply } });
```

Or call `sendChatAction` directly for other actions (`upload_photo`, `record_video`, etc.):

```typescript
await adapter.sendChatAction(contact.channelUserId, 'upload_photo');
```

### Webhook diagnostics

```typescript
const adapter = hub.getAdapter('telegram') as TelegramAdapter;
const info = await adapter.getWebhookInfo();
console.log(info.url, info.pendingUpdateCount, info.lastErrorMessage);
```

### Bot identity

```typescript
const bot = await adapter.getBotInfo();
// { id: 123456789, username: 'my_bot', firstName: 'My Bot', ... }
```

`getBotInfo()` returns structured data (`id`, `username`, `firstName`) — use it to populate operator UIs. `verifyCredentials()` returns a human-readable summary string.

### Downloading a media attachment

```typescript
const adapter = hub.getAdapter('telegram') as TelegramAdapter;
const file = await adapter.downloadMedia({ kind: 'platform-id', value: msg.content.mediaRef.value });
// file.data is a Uint8Array
```

## Common pitfalls

- **Inline button taps not arriving**: Telegram's default `allowed_updates` excludes `callback_query`. Pass `allowedUpdates: ['message', 'edited_message', 'callback_query']` when calling `setWebhook`.
- **User sees a loading spinner on tapped buttons forever**: you must call `adapter.answerCallbackQuery(msg.interaction.id)` within 10 seconds of receiving the `callback_query`. Without this call the spinner never dismisses.
- **Webhook not firing**: confirm registration with `adapter.getWebhookInfo()` (or `curl https://api.telegram.org/bot${TOKEN}/getWebhookInfo`). Look at `lastErrorMessage` and `pendingUpdateCount`.
- **`{"ok":false,"description":"Wrong response from the webhook"}`**: your server isn't returning 200 in time. The hub returns 200 only after it processes the body — keep your `hub.on('message')` handler fast or move work into a queue.
- **Webhook signature rejected**: if you set `TELEGRAM_WEBHOOK_SECRET`, you must also pass `secret_token=...` in the `setWebhook` URL. Mismatched values cause `InvalidSignature`.
- **ngrok URL keeps changing**: free ngrok rotates the URL on each restart. After ngrok restarts, you must re-run `setWebhook` with the new URL.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
