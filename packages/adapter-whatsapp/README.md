# @msgly/whatsapp

> WhatsApp Cloud API adapter for [Msgly](https://github.com/AyushJain070401/chatterbox). Send and receive WhatsApp messages through the unified `MessagingHub` interface — text, all media types, interactive buttons, quick replies, reactions, and pre-approved templates.

## Install

```bash
npm install @msgly/core @msgly/whatsapp
```

## Quick start

```typescript
import express from 'express';
import { MessagingHub } from '@msgly/core';
import { WhatsAppAdapter } from '@msgly/whatsapp';

const hub = new MessagingHub();

hub.register(new WhatsAppAdapter({
  phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
  accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
}));

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: 'whatsapp',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
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
interface WhatsAppConfig {
  /** Phone number ID (the long numeric id, not the human phone). */
  phoneNumberId: string;

  /** Cloud API access token — temporary (24h) or System User (permanent). */
  accessToken: string;

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

## Setup (20 minutes)

1. **Create a Meta App.** Go to [developers.facebook.com](https://developers.facebook.com) → My Apps → **Create App** → Business type.
2. **Add the WhatsApp product** to your app → Set up.
3. **Copy test credentials** from the **API Setup** tab:
   - **Phone number ID** (the long numeric one, NOT the human-readable phone) → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary access token** (24h) → `WHATSAPP_ACCESS_TOKEN`
4. **Get the App Secret.** Settings → Basic → Show next to App Secret → `META_APP_SECRET`.
5. **Pick a verify token.** Any random string. Use the same value here and in the webhook config form → `META_VERIFY_TOKEN`.
6. **Add a test recipient.** API Setup → "To" dropdown → Manage phone number list → add your personal WhatsApp number (test mode allows up to 5).
7. **Subscribe the webhook.** WhatsApp → **Configuration** tab:
   - Callback URL: `<PUBLIC_URL>/webhook/whatsapp`
   - Verify token: same value as `META_VERIFY_TOKEN`
   - Click **Verify and Save** (your server must be running)
   - Webhook fields → Subscribe to `messages`

8. **Test.** From your personal WhatsApp, message the test number. Your bot replies via `hub.on('message', ...)`.

> **Production tokens.** The 24-hour token works for testing only. For production, create a System User token: Business Settings → Users → **System Users** → create one → Generate Token with scopes `whatsapp_business_messaging` and `whatsapp_business_management`. System User tokens don't expire.

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
| templates     | ✓         |
| reactions     | ✓         |
| typing        | —         |

WhatsApp interactive buttons are capped at 3 buttons with 20-char labels. The adapter silently truncates to fit instead of failing with cryptic Cloud API errors.

## The 24-hour window

WhatsApp's policy: **free-form** replies (text, media, interactive) only work within 24 hours of an inbound user message. Outside that window you must send a pre-approved **template**.

Templates are created and approved in Meta dashboard → WhatsApp → **Message Templates**. Approval usually takes minutes for transactional templates.

```typescript
await hub.send({
  channel: 'whatsapp',
  account: { channel: 'whatsapp', channelAccountId: process.env.WHATSAPP_PHONE_NUMBER_ID! },
  contact: { channel: 'whatsapp', channelUserId: '919999999999' },
  content: {
    type: 'template',
    templateName: 'order_confirmation',
    language: 'en',
    variables: { '1': 'Udesh', '2': 'ORDER-12345' },
  },
});
```

Variable keys are positional — `'1'` maps to `{{1}}` in the template body.

## Sending examples

### Image

```typescript
await hub.send({
  channel: 'whatsapp',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/cat.png' },
    caption: 'meow',
  },
});
```

WhatsApp requires the URL to be publicly accessible HTTPS, or you can upload first:

```typescript
const adapter = hub.getAdapter('whatsapp');
const ref = await adapter.uploadMedia({
  data: fs.readFileSync('./cat.png'),
  mimeType: 'image/png',
});

await hub.send({
  channel: 'whatsapp',
  account, contact,
  content: { type: 'image', mediaRef: ref, caption: 'meow' },
});
```

### Interactive buttons

```typescript
await hub.send({
  channel: 'whatsapp',
  account, contact,
  content: {
    type: 'interactive',
    text: 'Confirm your order?',
    buttons: [
      { id: 'confirm', label: 'Confirm' },
      { id: 'cancel',  label: 'Cancel' },
    ],
  },
});
```

User taps a button → you receive a text message whose `content.text` equals the button's `id`.

## Common pitfalls

- **`(#131047)` re-engagement message**: you're outside the 24-hour window. Use a template.
- **`(#131030)` recipient phone not in allowed list**: in test mode, recipients must be added under Manage phone number list. Or go through business verification to remove the limit.
- **`Invalid signature`**: your `appSecret` is wrong, OR your Express setup isn't capturing the raw body. The `verify` callback in `express.json()` is essential.
- **Verify handshake fails**: `META_VERIFY_TOKEN` must match byte-for-byte between code and the form in the Meta dashboard. Server must be reachable at the public URL when you click Verify.
- **Template send fails with `(#132001)`**: template name or language code doesn't match an approved template. Templates are case-sensitive.
- **Token expired after 24h**: replace the temporary access token with a System User token (see Setup → Production tokens).

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/chatterbox

## License

MIT
