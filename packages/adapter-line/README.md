# @msgly/line

> LINE Messaging API adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive LINE messages through the unified hub — text, image, video, audio, location, buttons, and quick replies. Supports LINE's free reply-token sends. **Zero classes, runs in Node, Next.js, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/line
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createLineAdapter } from '@msgly/line';

const hub = createHub();

hub.register(
  createLineAdapter({
    channelAccessToken: process.env.LINE_CHANNEL_ACCESS_TOKEN!,
    channelSecret: process.env.LINE_CHANNEL_SECRET!,
  }),
);

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
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

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
2. **Channel secret.** Open the channel → **Basic settings** → copy **Channel secret** → set as `LINE_CHANNEL_SECRET`.
3. **Channel access token.** **Messaging API** tab → under "Channel access token (long-lived)" click **Issue** → copy → set as `LINE_CHANNEL_ACCESS_TOKEN`.
4. **Webhook URL.** On the Messaging API tab:
   - Webhook URL: `<PUBLIC_URL>/webhook/line`
   - Toggle **Use webhook** to ON
   - Click **Verify** — should succeed
5. **Disable LINE's built-in replies.** Same tab:
   - "Auto-reply messages": **OFF** (otherwise LINE answers before your bot)
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
| quick replies | ✓ (max 13, 20-char labels) |
| templates     | —         |
| reactions     | —         |
| typing        | ✓         |

## Typing indicator

```typescript
hub.on('message', async (msg) => {
  if (msg.channel !== 'line') return;

  const adapter = hub.getAdapter('line') as LineAdapter;
  await adapter.sendTyping?.(msg.contact);  // shows the loading animation

  const reply = await generateReply(msg);   // AI work, etc.

  await hub.send({ channel: 'line', account: msg.account, contact: msg.contact,
    content: { type: 'text', text: reply } });
});
```

This calls LINE's [Loading Animation API](https://developers.line.biz/en/reference/messaging-api/#send-loading-animation) (`POST /v2/bot/chat/loading/start`) with `loadingSeconds: 20`. The animation disappears when you send a message or after the specified time. Errors are silently swallowed — a missing animation is non-fatal.

> **1:1 chats only.** The Loading Animation API only works in conversations where the user has followed your Official Account. It will silently fail in group chats.

## Reply tokens (free vs push)

LINE's pricing model:

- **Reply API** (uses a `replyToken` from the inbound event) — **free**, doesn't count against your monthly quota.
- **Push API** (no reply token) — counts against your push quota.

Reply tokens are single-use and **expire about 1 minute** after the inbound message. Use them when responding immediately:

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

Send without `replyToken` and the adapter falls back to push automatically.

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

- **Bot replies but user doesn't see it**: in the LINE Developers Console, "Auto-reply messages" must be **OFF**. It overrides your bot's responses.
- **`Invalid reply token`**: the token expired (>1 min) or was already used. Fall back to push by omitting `metadata.replyToken`.
- **`InvalidSignature`**: `LINE_CHANNEL_SECRET` is wrong, or your Express app isn't capturing the raw body. The `verify` callback in `express.json()` is essential.
- **Webhook verify fails in console**: server must be running and reachable at the public URL when you click Verify.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
