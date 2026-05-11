# @msgly/messenger

> Facebook Messenger adapter for [Msgly](https://github.com/AyushJain070401/chatterbox). Send and receive Messenger messages through the unified hub — text, all media types, buttons, quick replies, typing indicators. **Zero classes, runs in Node, Next.js, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/messenger
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createMessengerAdapter } from '@msgly/messenger';

const hub = createHub();

hub.register(
  createMessengerAdapter({
    pageAccessToken: process.env.MESSENGER_PAGE_TOKEN!,
    appSecret: process.env.META_APP_SECRET!,
    verifyToken: process.env.META_VERIFY_TOKEN!,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.channel === 'messenger' && msg.content.type === 'text') {
    await hub.send({
      channel: 'messenger',
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
interface MessengerConfig {
  /** Page access token from Messenger → Generate Tokens. */
  pageAccessToken: string;

  /** App secret — used for X-Hub-Signature-256 verification. */
  appSecret: string;

  /** Your chosen string for the webhook GET handshake. */
  verifyToken: string;

  /** Override for tests. Defaults to https://graph.facebook.com. */
  apiBase?: string;

  /** Graph API version. Defaults to v20.0. */
  apiVersion?: string;
}
```

## Setup (15 minutes)

**Prerequisite:** a Facebook Page. Create one at [facebook.com/pages/create](https://facebook.com/pages/create) if needed.

1. **Create a Meta App** at [developers.facebook.com](https://developers.facebook.com) → Create App → Business type.
2. **App Secret.** Settings → Basic → Show next to App Secret → `META_APP_SECRET`.
3. **Verify token.** Any random string → `META_VERIFY_TOKEN`. Same value must be configured in Meta's webhook form.
4. **Add the Messenger product** → Set up.
5. **Generate a Page token.** Messenger → **Settings** → "Generate Tokens" → select your Page → **Generate Token**. Copy immediately — shown only once. Set as `MESSENGER_PAGE_TOKEN`.
6. **Webhook subscription.** Same Settings page → "Webhooks":
   - Callback URL: `<PUBLIC_URL>/webhook/messenger`
   - Verify token: same as `META_VERIFY_TOKEN`
   - Click **Verify and Save** (server must be running)
   - Subscription fields: tick `messages` and `messaging_postbacks`
7. **Subscribe the Page.** Same Webhooks section → next to your Page → **Subscribe**.
8. **Test.** Open Messenger, find your Page, send a message.

## Token expiry

Page tokens generated in the dashboard are short-lived in **Development mode** (~60 days). Two production paths:

- **Exchange for long-lived:**
  ```
  GET /oauth/access_token
    ?grant_type=fb_exchange_token
    &client_id={app-id}
    &client_secret={app-secret}
    &fb_exchange_token={short-lived-token}
  ```
- **Switch the app to Live mode** and use a System User token from Business Settings → Users → System Users. System User tokens don't expire.

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
| quick replies | ✓ (max 13, 20-char labels) |
| templates     | —         |
| reactions     | —         |
| typing        | ✓         |

## Sending examples

### Image

```typescript
await hub.send({
  channel: 'messenger',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/cat.png' },
  },
});
```

### Quick replies

```typescript
await hub.send({
  channel: 'messenger',
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

User taps → your `message` event fires with `content.text` equal to the button's `id`.

## Common pitfalls

- **Webhook verify fails in console**: `META_VERIFY_TOKEN` in code must match the value typed into the Meta form **byte-for-byte**. Server must be reachable at the public URL the moment you click Verify.
- **Bot replies arrive but user doesn't see them**: the App must be subscribed to the Page. Webhooks section → Subscribe next to the Page.
- **`InvalidSignature`**: wrong `appSecret`, or your Express app isn't capturing the raw body. The `verify` callback in `express.json()` is essential.
- **`(#10) Application does not have permission for this action`**: in Development mode, only Page admins/devs/testers can message the bot. Add the user under App Roles, or switch the App to Live mode.
- **Page token suddenly invalid**: short-lived tokens expire (~60 days in dev mode). See [Token expiry](#token-expiry).

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/chatterbox

## License

MIT
