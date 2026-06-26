# @msgly/whatsapp

> WhatsApp Cloud API adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive WhatsApp messages through the unified hub — text, all media types, interactive buttons, quick replies, reactions, and pre-approved templates. **Zero classes, runs in Node, Next.js, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/whatsapp
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createWhatsAppAdapter } from '@msgly/whatsapp';

const hub = createHub();

hub.register(
  createWhatsAppAdapter({
    phoneNumberId: process.env.WHATSAPP_PHONE_NUMBER_ID!,
    accessToken: process.env.WHATSAPP_ACCESS_TOKEN!,
    appSecret: process.env.META_APP_SECRET!,
    verifyToken: process.env.META_VERIFY_TOKEN!,
  }),
);

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
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Config

```typescript
interface WhatsAppConfig {
  phoneNumberId: string;  // long numeric id from API Setup
  accessToken: string;    // temporary (24h) or System User token
  appSecret: string;      // from App Settings → Basic
  verifyToken: string;    // your chosen string for webhook handshake
  /** WABA ID — required for template management, phone number list, and webhook subscription. */
  wabaId?: string;
  /** App ID — required for profile picture upload and token introspection. */
  appId?: string;
  apiBase?: string;       // defaults to https://graph.facebook.com
  apiVersion?: string;    // defaults to v20.0
}
```

## Setup (20 minutes)

1. **Create a Meta App.** Go to [developers.facebook.com](https://developers.facebook.com) → My Apps → **Create App** → Business type.
2. **Add the WhatsApp product** to your app → Set up.
3. **Copy test credentials** from the **API Setup** tab:
   - **Phone number ID** (long numeric, NOT the human phone) → `WHATSAPP_PHONE_NUMBER_ID`
   - **Temporary access token** (24h) → `WHATSAPP_ACCESS_TOKEN`
4. **Get the App Secret.** Settings → Basic → Show next to App Secret → `META_APP_SECRET`.
5. **Pick a verify token.** Any random string → `META_VERIFY_TOKEN`.
6. **Add a test recipient.** API Setup → "To" dropdown → Manage phone number list → add your personal WhatsApp number (max 5 in test mode).
7. **Subscribe the webhook.** WhatsApp → **Configuration** tab:
   - Callback URL: `<PUBLIC_URL>/webhook/whatsapp`
   - Verify token: same as `META_VERIFY_TOKEN`
   - Click **Verify and Save** (your server must be running)
   - Webhook fields → Subscribe to `messages`
8. **Test.** Message the test number from your personal WhatsApp.

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
| buttons       | ✓ (max 3, 20-char labels) |
| quick replies | ✓         |
| templates     | ✓         |
| reactions     | ✓         |
| typing        | —         |

The adapter silently truncates button counts and label lengths to fit Meta's limits.

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
  data: new Uint8Array(/* image bytes */),
  mimeType: 'image/png',
});

await hub.send({
  channel: 'whatsapp',
  account, contact,
  content: { type: 'image', mediaRef: ref, caption: 'meow' },
});
```

`MediaFile.data` accepts `Uint8Array | Blob | ReadableStream<Uint8Array>` — pass whichever your environment naturally produces.

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

## Business profile

```typescript
import type { WhatsAppAdapter } from '@msgly/whatsapp';
const adapter = hub.getAdapter('whatsapp') as WhatsAppAdapter;

// Read current profile
const profile = await adapter.getBusinessProfile();
// { about, address, description, email, profilePictureUrl, websites, vertical }

// Update fields (pass only what you want to change)
await adapter.updateBusinessProfile({
  about: 'Fast shipping • Easy returns',
  email: 'support@example.com',
  websites: ['https://example.com'],
  vertical: 'RETAIL',
});

// Upload a new profile picture (requires config.appId)
import { readFileSync } from 'fs';
await adapter.uploadProfilePicture({
  data: readFileSync('./logo.jpg'),
  mimeType: 'image/jpeg',
  filename: 'logo.jpg',
});
```

## Display name

```typescript
// Request a display name change (goes through WhatsApp review)
const result = await adapter.requestDisplayName('Acme Support');
// result.decision → "APPROVED" | "PENDING" | "DECLINED"
```

## Two-step verification PIN

```typescript
// Set or rotate the 6-digit PIN for the registered phone number
await adapter.setTwoStepPin('123456');
```

## Message templates

Requires `config.wabaId`.

```typescript
// List all templates (paginated)
const { templates, nextCursor } = await adapter.listTemplates({ limit: 20 });
// templates[0] → { id, name, status, category, language, components }

// Paginate
const page2 = await adapter.listTemplates({ limit: 20, after: nextCursor });

// Create a new template
const { id, status } = await adapter.createTemplate({
  name: 'order_shipped',
  category: 'UTILITY',
  language: 'en_US',
  components: [
    {
      type: 'BODY',
      text: 'Your order {{1}} has shipped! Track it at {{2}}.',
    },
  ],
});

// Edit an existing template's components
await adapter.editTemplate(id, {
  components: [{ type: 'BODY', text: 'Updated text {{1}}.' }],
});

// Delete (all language variants)
await adapter.deleteTemplate('order_shipped');

// Delete a specific language variant
await adapter.deleteTemplate('order_shipped', templateId);
```

## Phone number management

Requires `config.wabaId` for listing.

```typescript
// List all phone numbers in the WABA
const numbers = await adapter.listPhoneNumbers();
// [{ id, displayPhoneNumber, verifiedName, qualityRating, nameStatus }]

// Get info for the configured phone number (or pass a specific id)
const info = await adapter.getPhoneNumberInfo();
```

## Phone number registration flow

Use this when provisioning a new number for the first time:

```typescript
// 1. Request OTP
await adapter.requestVerificationCode({ codeMethod: 'SMS', language: 'en_US' });

// 2. Verify OTP (received by SMS)
await adapter.verifyCode('123456');

// 3. Register with a two-step PIN
await adapter.registerPhoneNumber('123456');
```

## WABA operations

Requires `config.wabaId`.

```typescript
// Get WABA metadata
const waba = await adapter.getWabaInfo();
// { id, name, currency, messageTemplateNamespace, timezoneId }

// Check which apps are subscribed to webhook events
const apps = await adapter.getSubscribedApps();

// Subscribe this app to WABA-level events (run once during deployment)
await adapter.subscribeToWebhook();
```

## Token introspection

Requires `config.appId` and `config.appSecret`.

```typescript
// Inspect the current access token
const info = await adapter.debugToken();
// { isValid, type, appId, expiresAt, scopes, userId }

// Inspect a different token
const info2 = await adapter.debugToken(someOtherToken);

if (!info.isValid) {
  console.error('Token is expired or invalid — rotate it');
}
```

## Delivery receipts

WhatsApp delivers status updates (delivered/read/failed) as separate webhook events. The hub's standard webhook handler ignores these for `hub.on('message')` purposes — if you need granular delivery tracking, use `adapter.parseStatuses(rawBody)`:

```typescript
const adapter = hub.getAdapter('whatsapp') as WhatsAppAdapter;
const receipts = adapter.parseStatuses(req.body);
// [{ status: 'delivered', messageId: '...', timestamp: '...' }, ...]
```

## Common pitfalls

- **`(#131047)` re-engagement message**: you're outside the 24-hour window. Use a template.
- **`(#131030)` recipient phone not in allowed list**: in test mode, recipients must be added under Manage phone number list. Business verification removes the limit.
- **`InvalidSignature`**: wrong `appSecret`, OR your Express setup isn't capturing the raw body. The `verify` callback in `express.json()` is essential.
- **Verify handshake fails**: `META_VERIFY_TOKEN` must match byte-for-byte between code and the form in the Meta dashboard. Server must be reachable when you click Verify.
- **Template send fails with `(#132001)`**: template name or language code doesn't match an approved template. Templates are case-sensitive.
- **Token expired after 24h**: replace the temporary access token with a System User token.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
