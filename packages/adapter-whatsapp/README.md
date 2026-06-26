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
| typing        | ✓ (`sendTypingIndicator`) |

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

For templates with an image/video header, URL buttons with a dynamic suffix, or quick-reply button payloads, pass the raw Meta `components` array instead of `variables`:

```typescript
await hub.send({
  channel: 'whatsapp',
  account, contact,
  content: {
    type: 'template',
    templateName: 'promo_with_image',
    language: 'en_US',
    // components wins over variables when both are present
    components: [
      {
        type: 'header',
        parameters: [{ type: 'image', image: { link: 'https://cdn.example.com/promo.jpg' } }],
      },
      {
        type: 'body',
        parameters: [{ type: 'text', text: 'Ayush' }, { type: 'text', text: '30%' }],
      },
      {
        type: 'button',
        sub_type: 'url',
        index: 0,
        parameters: [{ type: 'text', text: 'PROMO30' }],
      },
    ],
  },
});
```

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

User taps a button → you receive an inbound message where `content.text` is the button's visible label and `interaction.data` is the button's stable `id` — use `interaction.data` for CSAT / postback matching since labels can be localised.

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
// Read the current verified name and its review status
const { displayName, nameStatus } = await adapter.getDisplayName();
// nameStatus → "APPROVED" | "AVAILABLE_WITHOUT_REVIEW" | "PENDING_REVIEW" | "DECLINED" | "NONE"

// Request a display name change (goes through WhatsApp review)
const result = await adapter.requestDisplayName('Acme Support');
// result.decision → "APPROVED" | "PENDING" | "DECLINED"
```

## Two-step verification PIN

```typescript
// Set or rotate the 6-digit PIN for the registered phone number
await adapter.setTwoStepPin('123456');

// Disable two-step verification entirely
await adapter.removeTwoStepPin();
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

Use this to add a new number to your WABA. Requires `config.wabaId`.

```typescript
// 1. Add the number to the WABA (returns a phone_number_id)
const { id } = await adapter.createPhoneNumber({
  cc: '44',               // country calling code
  phoneNumber: '7911123456',
  verifiedName: 'Acme Support',
});

// 2. Request OTP (use the new id or set phoneNumberId in config)
await adapter.requestVerificationCode({ codeMethod: 'SMS', language: 'en_US' });

// 3. Verify OTP received by SMS
await adapter.verifyCode('123456');

// 4. Activate with a two-step PIN
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

// Per-WABA routing: override the callback URL for this specific WABA.
// Use this when one Meta App serves multiple tenants with different webhook URLs.
await adapter.subscribeToWebhook({
  overrideCallbackUri: 'https://tenant-a.example.com/webhook/whatsapp',
  verifyToken: process.env.META_VERIFY_TOKEN!,
});

// Unsubscribe when a WhatsApp channel is disconnected (stops webhook delivery)
await adapter.unsubscribeFromWebhook();
```

## App-level webhook fields

Run this once during initial app setup to choose which event types the Meta App receives. Requires `config.appId` and `config.appSecret`.

```typescript
await adapter.setAppWebhookFields([
  'messages',
  'message_template_status_update',
  'account_alerts',
  'phone_number_name_update',
  'phone_number_quality_update',
]);
```

This is equivalent to ticking fields in the Meta Dashboard → App → Webhooks but can be done programmatically during deployment.

## Facebook Embedded Signup

When using Meta's Embedded Signup widget to let users connect their own WhatsApp numbers, the frontend returns a short-lived auth code that your backend must exchange for a permanent token. Requires `config.appId` and `config.appSecret`.

```typescript
// Exchange the code returned by the Embedded Signup JS SDK
const { accessToken, tokenType, expiresIn } = await adapter.exchangeCodeForToken({
  code: req.query.code as string,
  redirectUri: 'https://app.example.com/connect/whatsapp/callback', // must match your app settings
});

// The resulting token is a user token — use debugToken to discover its WABA ID
const tokenInfo = await adapter.debugToken(accessToken);
const wabaId = tokenInfo.granularScopes
  ?.find(s => s.scope === 'whatsapp_business_management')
  ?.targetIds?.[0];
```

## Token introspection

Requires `config.appId` and `config.appSecret`.

```typescript
// Inspect the current access token
const info = await adapter.debugToken();
// { isValid, type, appId, expiresAt, scopes, userId, granularScopes }

// Inspect a different token
const info2 = await adapter.debugToken(someOtherToken);

if (!info.isValid) {
  console.error('Token is expired or invalid — rotate it');
}

// granularScopes: scope → WABA/page IDs the token covers
// Useful to auto-discover the WABA ID after Embedded Signup:
const wabaId = info.granularScopes
  ?.find(s => s.scope === 'whatsapp_business_management')
  ?.targetIds?.[0];
```

## Typing indicator

WhatsApp Cloud API added native typing bubbles in 2024. The adapter exposes two methods:

```typescript
// Show a typing bubble to the contact. Requires the externalId of their last inbound message.
await adapter.sendTypingIndicator(msg.contact, msg.externalId!);

// ... do AI work ...

await hub.send({ channel: 'whatsapp', account, contact, content: { type: 'text', text: reply } });
```

Under the hood this calls `POST /{phoneNumberId}/messages` with `status: "read"` + `typing_indicator: { type: "text" }`. The bubble disappears after ~25 seconds or when you send a message.

For generic cross-channel code that calls `sendTyping?.(contact)` without a message ID, `adapter.sendTyping` is a safe no-op — it won't throw.

### Mark as read (without typing)

To show the blue double-tick without a typing bubble:

```typescript
await adapter.markAsRead(msg.externalId!);
```

## Inbound message types

The adapter maps WhatsApp message types to the unified content model:

| WhatsApp type | Unified content | Notes |
|---------------|-----------------|-------|
| `text` | `TextContent` | |
| `image` | `MediaContent` (image) | |
| `video` | `MediaContent` (video) | |
| `audio` | `MediaContent` (audio) | |
| `document` | `MediaContent` (file) | |
| `sticker` | `MediaContent` (image, `image/webp`) | |
| `location` | `LocationContent` | |
| `contacts` | `TextContent` | Formatted contact names |
| `reaction` | `TextContent` (emoji) | `msg.metadata.reactedToMessageId` + `msg.metadata.reactionEmoji` |
| `order` | `TextContent` | Catalog + order text summary |
| `button` | `TextContent` (label) | `msg.interaction.data` = button payload |
| `interactive` (button_reply) | `TextContent` (label) | `msg.interaction.data` = button ID |
| `interactive` (list_reply) | `TextContent` (label) | `msg.interaction.data` = option ID |
| `interactive` (nfm_reply) | `TextContent` | Flow `response_json` content |
| `system` / `unsupported` | — | Dropped (not user-initiated) |

For reactions, check `msg.metadata`:

```typescript
hub.on('message', (msg) => {
  if (msg.metadata?.reactedToMessageId) {
    const emoji = msg.metadata.reactionEmoji as string;
    const reactedId = msg.metadata.reactedToMessageId as string;
    // handle reaction
  }
});
```

## Delivery receipts

WhatsApp delivers status updates (delivered/read/failed) as separate webhook events. The hub's standard webhook handler ignores these for `hub.on('message')` purposes — if you need granular delivery tracking, use `adapter.parseStatuses(rawBody)`:

```typescript
const adapter = hub.getAdapter('whatsapp') as WhatsAppAdapter;
const receipts = adapter.parseStatuses(req.body);
// [{
//   status: 'delivered',
//   messageId: 'wamid.xxx',
//   recipientId: '919999999999',  // which contact the status is for
//   timestamp: '...',
//   error?: { code: '131000', message: '...' }  // raw Meta error code, no prefix
// }]
```

`error.code` is the raw Meta numeric code as a string (e.g. `"131000"`) — no `wa_` prefix.

## Signature verification debugging

`verifySignature(req)` returns a boolean. When you need to know _why_ a webhook is failing:

```typescript
const result = await adapter.verifySignatureVerbose(req);
// { ok: false, reason: 'mismatch' | 'no_signature' | 'bad_format' | 'no_secret' }

if (!result.ok) {
  if (result.reason === 'no_secret')    console.error('appSecret not configured');
  if (result.reason === 'no_signature') console.error('X-Hub-Signature-256 header missing');
  if (result.reason === 'bad_format')   console.error('header does not start with sha256=');
  if (result.reason === 'mismatch')     console.error('HMAC does not match — wrong appSecret or raw body lost');
}
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
