# @msgly/instagram

> Instagram Direct adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive Instagram DMs through the unified hub — text, image, video, quick replies, reactions. **Zero classes, runs in Node, Next.js, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/instagram
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createInstagramAdapter } from '@msgly/instagram';

const hub = createHub();

hub.register(
  createInstagramAdapter({
    pageAccessToken: process.env.INSTAGRAM_PAGE_TOKEN!,
    appSecret: process.env.META_APP_SECRET!,
    verifyToken: process.env.META_VERIFY_TOKEN!,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.channel === 'instagram' && msg.content.type === 'text') {
    await hub.send({
      channel: 'instagram',
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
interface InstagramConfig {
  /** IG-enabled Page access token (from Messenger → Instagram Settings, or via Instagram Login). */
  pageAccessToken: string;

  /** App secret — used for X-Hub-Signature-256 verification and token exchanges. */
  appSecret: string;

  /** Your chosen string for the webhook GET handshake. */
  verifyToken: string;

  /**
   * Facebook App ID (from App Dashboard → General Information → App ID).
   * Required only when using the Instagram Login OAuth helpers.
   */
  appId?: string;

  /** Override for tests. Defaults to https://graph.facebook.com. */
  apiBase?: string;

  /** Graph API version. Defaults to v20.0. */
  apiVersion?: string;
}
```

## Authentication

Two ways to obtain a `pageAccessToken`:

### Option A — Facebook Login (traditional)

1. Open your Meta App → Messenger → Instagram Settings → **Generate Token**.
2. Copy the token and set `INSTAGRAM_PAGE_TOKEN`. This is a short-lived token (~60 days in dev mode). Exchange for a long-lived one via the token debug tool, or use a System User.

### Option B — Instagram Login (new in 0.3.0)

Instagram Login uses `api.instagram.com`/`graph.instagram.com` endpoints and is the preferred approach for apps that need users to log in with their Instagram Business accounts:

```typescript
import { createInstagramAdapter } from '@msgly/instagram';

const adapter = createInstagramAdapter({
  appId: process.env.INSTAGRAM_APP_ID!,
  appSecret: process.env.INSTAGRAM_APP_SECRET!,
  pageAccessToken: '', // placeholder — will be set after OAuth
  verifyToken: process.env.META_VERIFY_TOKEN!,
});

// 1. Redirect user here to grant permissions
app.get('/auth/instagram', (req, res) => {
  const url = adapter.getAuthUrl({
    appId: process.env.INSTAGRAM_APP_ID!,
    redirectUri: 'https://myapp.example.com/auth/instagram/callback',
    scopes: ['instagram_business_basic', 'instagram_business_manage_messages'],
    state: req.session.csrf,
  });
  res.redirect(url);
});

// 2. Exchange the code for a short-lived token, then upgrade to long-lived
app.get('/auth/instagram/callback', async (req, res) => {
  const { code } = req.query;

  const short = await adapter.exchangeCode(code as string, {
    appId: process.env.INSTAGRAM_APP_ID!,
    appSecret: process.env.INSTAGRAM_APP_SECRET!,
    redirectUri: 'https://myapp.example.com/auth/instagram/callback',
  });

  const long = await adapter.getLongLivedToken(short.accessToken);
  // long.accessToken lasts ~60 days, long.expiresIn is in seconds

  // Persist long.accessToken and refresh before it expires:
  // await adapter.refreshToken(savedToken) — resets the 60-day clock
  res.json({ token: long.accessToken, expiresIn: long.expiresIn });
});
```

Token lifecycle:
- **Short-lived**: `exchangeCode()` — ~1 hour
- **Long-lived**: `getLongLivedToken(short)` — ~60 days
- **Refreshed**: `refreshToken(long)` — resets to 60 days (call at least 24 h before expiry)

## Setup (15 minutes)

**Prerequisites:**

1. An **Instagram Business** or **Creator** account (Instagram app: Settings → Account → Switch to Professional Account).
2. A Facebook Page **linked** to that Instagram account (Page Settings → Linked Accounts → Instagram).
3. A Meta App with the **Messenger product** already added (same App used by [@msgly/messenger](https://www.npmjs.com/package/@msgly/messenger)). All three Meta channels share one App and one App Secret.

**Steps:**

1. **Add Instagram to your App.** Meta App → Messenger → **Instagram Settings** tab → **Add or Remove Pages** → tick the Page linked to your IG account.
2. **Generate the IG-enabled token.** Same Instagram Settings tab → **Generate Token**. Set as `INSTAGRAM_PAGE_TOKEN`.
3. **Subscribe webhooks.** Webhooks section on the Instagram Settings tab:
   - Callback URL: `<PUBLIC_URL>/webhook/instagram`
   - Verify token: same `META_VERIFY_TOKEN` as Messenger / WhatsApp
   - Subscribe to `messages`
4. **Allow message access on the IG side.** Instagram app: Settings → Privacy → Messages → **"Allow access to messages"** must be **ON**. Without this, your bot cannot receive DMs.
5. **Test.** From a different IG account, send a DM to your Business account.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image         | ✓         |
| video         | ✓         |
| audio         | —         |
| file          | —         |
| location      | ✓         |
| buttons       | —         |
| quick replies | ✓         |
| templates     | —         |
| reactions     | ✓         |
| typing        | ✓         |

Instagram does not support audio sends, file attachments, or persistent buttons. Attempts throw a `MsglyError` with `code: 'UnsupportedFeature'`:

```typescript
import { isMsglyError } from '@msgly/core';

try {
  await hub.send({ channel: 'instagram', /* ... */ content: { type: 'audio', mediaRef } });
} catch (err) {
  if (isMsglyError(err, 'UnsupportedFeature')) {
    // Instagram does not support audio sends
  }
}
```

## 24-hour messaging window

Like Messenger, Instagram restricts free-form replies to the **24-hour standard messaging window** after the user's last inbound message. Outside that window, only specific message tags (e.g. `HUMAN_AGENT`) or the Instagram Private Reply API may apply. For a chatbot, keep replies inside the 24-hour window or design proactive flows around the user initiating contact.

## Sending examples

### Image

```typescript
await hub.send({
  channel: 'instagram',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/cat.jpg' },
  },
});
```

The URL must be public HTTPS.

### Quick replies

```typescript
await hub.send({
  channel: 'instagram',
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

Rendered as Instagram quick-reply chips. User tap → your `message` handler receives a text message whose `content.text` matches the chosen button's `id`.

## Formatting

Instagram DMs are plain text — markdown and HTML are not rendered. The `fmt` export is provided so code that imports `fmt` from any adapter compiles uniformly; each helper returns the text unchanged:

```typescript
import { fmt } from '@msgly/instagram';

fmt.bold('Hello')  // → 'Hello'
fmt.italic('world') // → 'world'
fmt.link('click', 'https://example.com') // → 'click'
```

## Common pitfalls

- **Bot doesn't receive DMs**: the IG Business account must have **"Allow access to messages"** ON (Instagram app → Settings → Privacy → Messages).
- **`(#10) Application does not have permission`**: the IG account isn't linked to the FB Page, or the Page isn't connected in the Instagram Settings tab of the Meta App.
- **Webhook verify fails in console**: `META_VERIFY_TOKEN` mismatch, or server unreachable at the public URL when you click Verify.
- **`InvalidSignature`**: wrong `appSecret`, or your Express setup isn't capturing the raw body. The `verify` callback in `express.json()` is essential.
- **`(#100) Invalid parameter` on audio send**: Instagram does not support audio. Catch `UnsupportedFeature` errors before sending, or check `adapter.capabilities.media.audio === false`.
- **Page token suddenly invalid**: short-lived tokens expire (~60 days in dev mode). Exchange for a long-lived token via `/oauth/access_token?grant_type=fb_exchange_token`, or use a System User token in Live mode.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
