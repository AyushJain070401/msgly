# @msgly/wechat

> WeChat Official Account adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive WeChat messages through the unified hub — text, image, video, voice, location, menu interactions. **Zero classes, runs in Node and Next.js.**

## Install

```bash
npm install @msgly/core @msgly/wechat
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createWeChatAdapter } from '@msgly/wechat';

const hub = createHub();

hub.register(
  createWeChatAdapter({
    appId: process.env.WECHAT_APP_ID!,
    appSecret: process.env.WECHAT_APP_SECRET!,
    token: process.env.WECHAT_TOKEN!,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.channel === 'wechat' && msg.content.type === 'text') {
    await hub.send({
      channel: 'wechat',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
    });
  }
});

const app = express();
// WeChat sends XML — capture rawBody as bytes
app.use(express.raw({ type: '*/*', verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

const handlers = hub.createWebhookHandler();
// WeChat uses GET for challenge verification and POST for messages
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Config

```typescript
interface WeChatConfig {
  /** WeChat Official Account App ID (mp.weixin.qq.com → Development → Basic Configuration). */
  appId: string;

  /** WeChat Official Account App Secret. */
  appSecret: string;

  /**
   * Token you set in Development → Basic Configuration → Token.
   * Used to verify that webhook calls are genuine WeChat requests.
   */
  token: string;

  /** Override for tests. Defaults to https://api.weixin.qq.com. */
  apiBase?: string;
}
```

## Setup (15 minutes)

**Prerequisites:** A WeChat Official Account (Service Account or Subscription Account). Service Accounts get more API quota and are required for the Customer Service message API.

1. Open [mp.weixin.qq.com](https://mp.weixin.qq.com) → **Settings → Official Account Settings → Account Details** and note your App ID.
2. Go to **Development → Basic Configuration**:
   - Enable developer mode (启用).
   - Set **Token** to any random string — save it as `WECHAT_TOKEN`.
   - Set **Server Address (URL)** to `<PUBLIC_URL>/webhook/wechat`.
   - Submit — WeChat sends a GET request with a challenge to verify the URL.
3. Copy **AppID** and **AppSecret** from the same page.
4. Set environment variables:
   ```bash
   WECHAT_APP_ID=wx...
   WECHAT_APP_SECRET=...
   WECHAT_TOKEN=your-random-token
   ```
5. For the Customer Service Message API (sending replies), go to **Development → API Permissions** and ensure `客服消息` (Customer Service Message) is enabled.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image         | ✓         |
| video         | ✓         |
| audio (voice) | ✓         |
| file          | —         |
| location      | ✓ (recv) / text (send) |
| buttons       | —         |
| quick replies | ✓ (msgmenu) |
| reactions     | —         |
| typing        | —         |
| templates     | —         |

## Access token management

WeChat access tokens expire every 2 hours. The adapter caches the token in memory and refreshes it automatically with a 60-second buffer. For multi-process deployments (PM2 cluster, serverless), each process caches independently — if you need a shared token store, call `adapter.getAccessToken()` and manage caching yourself:

```typescript
const adapter = createWeChatAdapter(config);
const token = await adapter.getAccessToken();
// Use `token` directly with the WeChat Graph API
```

## Sending examples

### Text

```typescript
await hub.send({
  channel: 'wechat',
  account, contact,
  content: { type: 'text', text: 'Hello!' },
});
```

### Image

WeChat requires uploading media first to get a `media_id`:

```typescript
import { readFileSync } from 'fs';

const adapter = hub.getAdapter('wechat') as WeChatAdapter;
const ref = await adapter.uploadMedia({
  data: readFileSync('./banner.jpg'),
  mimeType: 'image/jpeg',
  filename: 'banner.jpg',
});

await hub.send({
  channel: 'wechat',
  account, contact,
  content: { type: 'image', mediaRef: ref },
});
```

Note: Temporary media IDs from `uploadMedia` expire after **3 days**.

### Quick reply menu (msgmenu)

```typescript
await hub.send({
  channel: 'wechat',
  account, contact,
  content: {
    type: 'interactive',
    text: 'How can I help you?',
    buttons: [
      { id: 'track', label: 'Track my order' },
      { id: 'return', label: 'Return an item' },
      { id: 'faq', label: 'FAQ' },
    ],
  },
});
```

When the user taps an option, your `message` handler receives an `InboundMessage` with `interaction.id` equal to the button's `id`:

```typescript
hub.on('message', async (msg) => {
  if (msg.interaction) {
    console.log('user tapped:', msg.interaction.id);
  }
});
```

Maximum 5 items per menu (3 for Subscription Accounts).

## Formatting

WeChat DMs are plain text. The `fmt` export is provided so code that imports `fmt` from any adapter compiles uniformly:

```typescript
import { fmt } from '@msgly/wechat';
fmt.bold('Hello')  // → 'Hello' (pass-through)
```

## Webhook body parsing

WeChat sends messages as **XML** (not JSON). Your Express middleware must not parse the body before the adapter sees it. Use `express.raw()` to capture raw bytes:

```typescript
// ✓ Correct — raw bytes preserved
app.use(express.raw({ type: '*/*', verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

// ✗ Wrong — express.json() will fail to parse XML and throw before the adapter runs
app.use(express.json());
```

## Common pitfalls

- **GET challenge fails**: the `token` in config must exactly match the Token field in the WeChat console. A single character difference causes a signature mismatch.
- **"System busy" (errcode: -1)**: usually a rate-limit or token issue. Check that `appId` and `appSecret` are correct and the account is in developer mode.
- **Messages arrive but no reply sent**: the Customer Service Message API (`客服消息`) requires the user to have sent a message in the past **48 hours**. Outside this window, use template messages (requires additional approval from WeChat).
- **Media sends fail**: temporary media IDs expire after 3 days. Re-upload if you store IDs long-term.
- **Multi-process token contention**: each Node process maintains its own token cache. Under high concurrency you may get brief duplicate refresh calls — WeChat handles this gracefully, but if token quota is a concern, centralize token storage in Redis.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
