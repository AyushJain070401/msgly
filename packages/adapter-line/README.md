# @msgly/line

> LINE Messaging API adapter for [Msgly](https://github.com/AyushJain070401/chatterbox). Send and receive LINE messages through the unified `MessagingHub` interface — text, image, video, audio, location, buttons, and quick replies. Supports LINE's free reply-token sends.

## Install

```bash
npm install @msgly/core @msgly/line
```

## Quick start

```typescript
import express from 'express';
import { MessagingHub } from '@msgly/core';
import { LineAdapter } from '@msgly/line';

const hub = new MessagingHub();

hub.register(new LineAdapter({
  channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
  channelSecret: process.env.LINE_CHANNEL_SECRET!,
}));

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.channel === 'line' && msg.content.type === 'text') {
    // Use the free reply token when available
    await hub.send({
      channel: 'line',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
      metadata: { replyToken: msg.metadata?.replyToken },
    });
  }
});

const app = express();
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = buf) }));

const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Config

```typescript
interface LineConfig {
  /** Long-lived channel access token from the Messaging API tab. */
  channelAccessToken: string;

  /** Channel secret from Basic settings — used for webhook signature verification. */
  channelSecret: string;

  /** Override for tests. Defaults to https://api.line.me */
  apiBase?: string;

  /** Override for tests. Defaults to https://api-data.line.me (media endpoints). */
  dataApiBase?: string;
}
```

## Setup (10 minutes)

1. Sign up at [developers.line.biz](https://developers.line.biz). Create a **Provider**, then a **Messaging API channel** inside it.
2. **Channel secret.** Open the channel → **Basic settings** tab → copy **Channel secret** → set as `LINE_CHANNEL_SECRET`.
3. **Channel access token.** Switch to the **Messaging API** tab → under "Channel access token (long-lived)" click **Issue** → copy → set as `LINE_CHANNEL_ACCESS_TOKEN`.
4. **Webhook URL.** Still on the Messaging API tab:
   - Webhook URL: `<PUBLIC_URL>/webhook/line`
   - Toggle **Use webhook** to ON
   - Click **Verify** — should succeed
5. **Disable LINE's built-in replies.** Same tab:
   - "Auto-reply messages": **OFF** (otherwise LINE answers before your bot does)
   - "Greeting messages": OFF (optional)
6. **Add the bot to a chat.** Find the bot's QR code on the Messaging API tab → scan with the LINE app → add as friend → message it.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image         | ✓         |
| video         | ✓         |
| audio         | ✓         |
| file          | —         |
| location      | ✓         |
| buttons       | ✓         |
| quick replies | ✓         |
| templates     | —         |
| reactions     | —         |
| typing        | —         |

LINE quick replies are capped at 13 items with 20-char labels. The adapter truncates silently to fit.

## Reply tokens (free vs push)

LINE's pricing model:

- **Reply API** (uses a `replyToken` from the inbound event) — **free**, doesn't count against your monthly quota.
- **Push API** (no reply token) — counts against your push quota.

Reply tokens are single-use and **expire about 1 minute** after the inbound message. Use them when responding immediately to a user message:

```typescript
hub.on('message', async (msg) => {
  if (msg.channel === 'line' && msg.content.type === 'text') {
    await hub.send({
      channel: 'line',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: 'thanks!' },
      metadata: { replyToken: msg.metadata?.replyToken },  // ← free reply
    });
  }
});
```

Send without `replyToken` and the adapter falls back to push automatically:

```typescript
// Pushed (counts against quota) — fine for proactive sends or > 1 min delay
await hub.send({
  channel: 'line',
  account, contact,
  content: { type: 'text', text: 'order shipped!' },
});
```

## Sending examples

### Image

```typescript
await hub.send({
  channel: 'line',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/cat.jpg' },
  },
});
```

LINE requires media URLs to be public HTTPS with no auth.

### Quick replies

```typescript
await hub.send({
  channel: 'line',
  account, contact,
  content: {
    type: 'interactive',
    text: 'Pick one:',
    buttons: [
      { id: 'a', label: 'Option A' },
      { id: 'b', label: 'Option B' },
    ],
  },
});
```

User tap → you receive a text message whose `content.text` matches the button `id`.

## Common pitfalls

- **Bot replies but user doesn't see it**: in the LINE Developers Console, make sure "Auto-reply messages" is **OFF**. It overrides your bot's responses.
- **`Invalid reply token`**: the token expired (>1 min) or was already used. Fall back to push by omitting `metadata.replyToken`.
- **`Invalid signature`**: `LINE_CHANNEL_SECRET` is wrong, or your Express app isn't capturing the raw body. The `verify` callback in `express.json()` is essential.
- **Webhook verify fails in console**: make sure the server is running and reachable at the public URL when you click Verify.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/chatterbox

## License

MIT
