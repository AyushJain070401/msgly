# @msgly/core

> Core engine for Msgly — unified message model, the `createHub` factory, retry, idempotency, capability checks, and the `Adapter` contract every channel package implements. **Zero classes, runs in Node 18+, Next.js (Node + Edge), and the browser.**

`@msgly/core` is the runtime every channel adapter plugs into. You won't usually depend on it directly for application code — install it alongside one or more adapters:

**Chat / messaging**: `@msgly/telegram`, `@msgly/whatsapp`, `@msgly/line`, `@msgly/messenger`, `@msgly/instagram`, `@msgly/discord`, `@msgly/msteams`, `@msgly/slack`, `@msgly/wechat`

**Email**: `@msgly/gmail`, `@msgly/outlook`

## Install

```bash
npm install @msgly/core
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createTelegramAdapter } from '@msgly/telegram';
import { createWhatsAppAdapter } from '@msgly/whatsapp';

const hub = createHub();

hub.register(
  createTelegramAdapter({
    botToken: process.env.TELEGRAM_BOT_TOKEN!,
    webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
  }),
);

hub.register(
  createWhatsAppAdapter({
    phoneNumberId: process.env.WA_PHONE_ID!,
    accessToken: process.env.WA_TOKEN!,
    appSecret: process.env.META_APP_SECRET!,
    verifyToken: process.env.META_VERIFY_TOKEN!,
  }),
);

// Verify credentials at startup — fail fast on bad tokens
await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: msg.channel,
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

## Concepts

### The unified message

Every inbound and outbound message conforms to the same shape, regardless of channel:

```typescript
interface UnifiedMessage {
  id: string;                  // library-generated UUID, stable across retries
  externalId?: string;         // the platform's own message id
  channel: ChannelName;        // 'telegram' | 'whatsapp' | 'line' | 'messenger' | 'instagram'
                               //   | 'discord' | 'msteams' | 'slack' | 'wechat' | 'gmail' | 'outlook'
  account: AccountRef;         // your business identity on that channel
  contact: ContactRef;         // the end user
  content: MessageContent;     // discriminated union, see below
  timestamp: string;           // ISO 8601
  direction: 'inbound' | 'outbound';
  metadata?: Record<string, unknown>;

  // Inbound-only fields:
  raw?: unknown;               // original platform payload
  interaction?: {              // present when the user tapped a button / postback
    id: string;                // platform callback ID — ack within 10 s (Telegram)
    data?: string;             // button payload (button.id, postback.payload, etc.)
  };
  edited?: boolean;            // true if this is an edit of a previous message
}
```

### Content types

`MessageContent` is a discriminated union:

```typescript
type MessageContent =
  | { type: 'text'; text: string;
      /** 'markdown' or 'html' enables native rich-text rendering per channel. */
      format?: 'plain' | 'markdown' | 'html' }
  | { type: 'image' | 'video' | 'audio' | 'file';
      mediaRef: MediaReference; caption?: string }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'interactive'; text: string;
      /** 1D = single row (back-compat). 2D = multi-row grid (e.g. Telegram inline keyboard). */
      buttons: { id: string; label: string }[] | { id: string; label: string }[][];
      /** 'inline' (default) = callback_data buttons. 'reply' = sends actual text (Telegram ReplyKeyboardMarkup). */
      keyboardType?: 'inline' | 'reply' }
  | { type: 'template'; templateName: string; language: string;
      /** Positional body variables — `'1'` maps to `{{1}}`. */
      variables?: Record<string, string>;
      /** Rich component pass-through (headers, URL buttons, media). Wins over variables. */
      components?: unknown[] };
```

### Message formatting

Each adapter exports a `fmt` helper object with channel-native formatting:

```typescript
import { fmt } from '@msgly/telegram';  // MarkdownV2 escaping
import { fmt } from '@msgly/discord';   // Discord markdown
import { fmt } from '@msgly/gmail';     // HTML tags
import { fmt } from '@msgly/outlook';   // HTML tags
import { fmt } from '@msgly/msteams';   // Markdown
import { fmt } from '@msgly/whatsapp';  // WhatsApp markdown
// Messenger, Instagram, LINE — fmt returns text as-is (plain only)
```

Pass `format: 'markdown'` or `format: 'html'` on `TextContent` to enable native rendering:

```typescript
import { fmt } from '@msgly/telegram';

await hub.send({
  channel: 'telegram',
  account, contact,
  content: {
    type: 'text',
    format: 'markdown',   // tells the adapter: parse_mode = MarkdownV2
    text: `${fmt.bold('Order confirmed')} — your tracking number is ${fmt.code('TRK-1234')}`,
  },
});
```

| Adapter     | `format: 'markdown'`                    | `format: 'html'`          | fmt helpers                                 |
| ----------- | --------------------------------------- | ------------------------- | ------------------------------------------- |
| Telegram    | `parse_mode: MarkdownV2`                | `parse_mode: HTML`        | bold, italic, underline, strike, code, pre, link, spoiler |
| WhatsApp    | always-on (auto-parsed)                 | —                         | bold, italic, strikethrough, monospace      |
| Discord     | always-on (auto-parsed)                 | —                         | bold, italic, underline, strike, code, codeBlock, spoiler, link |
| Slack       | mrkdwn section block                    | —                         | bold, italic, strikethrough, code, codeBlock, link |
| Teams       | `textFormat: markdown`                  | `textFormat: markdown`    | bold, italic, strikethrough, code, codeBlock, link |
| Gmail       | —                                       | `Content-Type: text/html` | bold, italic, underline, strike, code, pre, link, color, br |
| Outlook     | —                                       | `contentType: HTML`       | bold, italic, underline, strike, code, pre, link, color, br |
| Messenger   | plain (not supported)                   | —                         | identity functions                          |
| Instagram   | plain (not supported)                   | —                         | identity functions                          |
| LINE        | plain (not supported)                   | —                         | identity functions                          |
| WeChat      | plain (not supported)                   | —                         | identity functions                          |

### `AccountRef` and `ContactRef`

```typescript
interface AccountRef {
  channel: ChannelName;
  channelAccountId: string;    // bot id / phone_number_id / page id
}

interface ContactRef {
  channel: ChannelName;
  channelUserId: string;       // chat_id / phone number / page-scoped user id
  displayName?: string;
  globalContactId?: string;    // your cross-channel identity if you have one
}
```

## `createHub(options?)`

```typescript
function createHub(options?: HubOptions): Hub;

interface HubOptions {
  store?: MessageStore;             // default: in-memory
  logger?: Logger;                  // default: console-based (warn + error only)
  retry?: Partial<RetryOptions>;    // default: 3 attempts, 500ms base, 8000ms cap
}
```

### `hub.register(adapter)`

Registers a channel adapter. Throws `MsglyError` with `code: 'AdapterAlreadyRegistered'` on duplicate registration. Returns `hub` for chaining.

### `hub.send(message)`

Send a partial `OutboundMessage` — `id`, `direction`, and `timestamp` are filled in for you.

```typescript
await hub.send({
  channel: 'whatsapp',
  account: { channel: 'whatsapp', channelAccountId: '...' },
  contact: { channel: 'whatsapp', channelUserId: '919999999999' },
  content: { type: 'text', text: 'hi' },
});
```

Sends are wrapped in retry (see [Retry](#retry)) and validated against the target adapter's capabilities (see [Capability checks](#capability-checks)).

### `hub.on(event, handler)` — returns unsubscribe

```typescript
const off = hub.on('message',  (msg) => { /* handle inbound */ });
hub.on('delivery', (receipt) => { /* status updates */ });
hub.on('error',    (err, ctx) => { /* observe failures */ });

// Later:
off();
```

Unlike traditional `EventEmitter`-based libraries, `hub.on()` returns an unsubscribe function — no need to track handler references for cleanup.

### `hub.connect({ throwOnFailure? })`

Calls every registered adapter's `verifyCredentials()` in parallel. Returns `Record<ChannelName, CredentialsCheckResult>`. Pass `throwOnFailure: true` to throw an aggregated error if any adapter fails — useful in boot scripts.

```typescript
const report = await hub.connect();
// { telegram: { ok: true,  accountInfo: '@my_bot' },
//   whatsapp: { ok: false, reason: 'unauthorized', hint: '...' } }
```

The `hint` is an actionable string explaining exactly which env var to fix and where to find the value.

### `hub.createWebhookHandler()`

Returns `{ get, post }` for use with any Express-like framework:

- `GET /webhook/:channel` — handles the Meta-family subscription handshake (`hub.verify_token` check)
- `POST /webhook/:channel` — verifies the channel's signature (HMAC / Ed25519 / RS256 JWT / shared-secret depending on adapter), optionally short-circuits with a platform-specific ack body (Discord PONG, Graph `validationToken` echo), dispatches to the right adapter, deduplicates via `externalId`, emits `message` events

```typescript
const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);
```

> **Raw body is required.** Signature verification needs the byte-exact request body as a `Uint8Array`. Configure your body parser to expose it on `req.rawBody`. For Express, capture across **all content-types** so platform handshakes that arrive as `text/plain` (e.g. Microsoft Graph's `validationToken`) aren't dropped:
>
> ```typescript
> const captureRaw = (req, _res, buf) => { req.rawBody = new Uint8Array(buf); };
> app.use(express.json({ verify: captureRaw }));
> app.use(express.urlencoded({ extended: true, verify: captureRaw }));
> app.use(express.raw({ type: '*/*', verify: captureRaw })); // fallback for text/plain etc.
> ```

### `hub.handleWebhook(channel, req)`

The lower-level entry point used by `createWebhookHandler`. Useful when wiring webhooks into a framework that doesn't fit the Express shape, or directly inside Next.js Route Handlers / Server Actions.

### `hub.channels` / `hub.getAdapter(channel)`

`channels` returns the list of registered channel names. `getAdapter` returns the registered adapter, or throws a `MsglyError` with `code: 'AdapterNotRegistered'`.

### `hub.start()` / `hub.stop()`

Calls the optional `start()`/`stop()` lifecycle hooks on every registered adapter.

## Retry

Sends are wrapped in exponential backoff with **equal jitter**:

- `maxAttempts: 3` (configurable)
- `initialDelayMs: 500`
- `maxDelayMs: 8000`
- Backoff: `min(initial * 2^(attempt-1), maxDelay)` then `delay/2 + random(delay/2)`

Auth errors (401/403/404) and "unauthorized" codes are **never** retried — the token is bad, retrying just wastes API calls. Network errors and 5xx are retried.

```typescript
const hub = createHub({
  retry: {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 4000,
    shouldRetry: (err, attempt) => attempt < 3,
  },
});
```

## Capability checks

Every adapter advertises an `AdapterCapabilities` object:

```typescript
interface AdapterCapabilities {
  text: boolean;
  media: { image: boolean; video: boolean; audio: boolean; file: boolean };
  interactive: { buttons: boolean; quickReplies: boolean };
  templates: boolean;
  reactions: boolean;
  typing: boolean;
}
```

The hub checks `content.type` against these before dispatching. Unsupported sends throw a `MsglyError` with `code: 'UnsupportedFeature'`:

```typescript
import { isMsglyError } from '@msgly/core';

try {
  await hub.send({ channel: 'instagram', /* ... */ content: { type: 'audio', mediaRef } });
} catch (err) {
  if (isMsglyError(err, 'UnsupportedFeature')) {
    // Instagram does not support audio
  }
}
```

Cross-channel matrix:

| Feature        | Telegram | WhatsApp | LINE | Messenger | Instagram | Discord | Teams | Slack | WeChat | Gmail | Outlook |
| -------------- | -------- | -------- | ---- | --------- | --------- | ------- | ----- | ----- | ------ | ----- | ------- |
| text           | ✓        | ✓        | ✓    | ✓         | ✓         | ✓       | ✓     | ✓     | ✓      | ✓     | ✓       |
| image          | ✓        | ✓        | ✓    | ✓         | ✓         | ✓       | ✓     | ✓(URL)| ✓      | —     | —       |
| video          | ✓        | ✓        | ✓    | ✓         | ✓         | ✓       | —     | —     | ✓      | —     | —       |
| audio          | ✓        | ✓        | ✓    | ✓         | —         | ✓       | —     | —     | ✓      | —     | —       |
| file           | ✓        | ✓        | —    | ✓         | —         | ✓       | ✓     | —     | —      | —     | —       |
| buttons        | ✓        | ✓        | ✓    | ✓         | —         | ✓       | ✓     | ✓     | —      | —     | —       |
| quick replies  | ✓        | ✓        | ✓    | ✓         | ✓         | —       | —     | —     | ✓      | —     | —       |
| templates      | —        | ✓        | —    | —         | —         | —       | —     | —     | —      | —     | —       |
| reactions      | ✓        | ✓        | —    | —         | ✓         | —       | —     | —     | —      | —     | —       |
| typing         | ✓        | ✓†       | ✓    | ✓         | ✓         | —       | ✓     | —     | —      | —     | —       |

† WhatsApp requires the inbound message's `externalId` — use `adapter.sendTypingIndicator(contact, externalMessageId)` rather than the generic `sendTyping(contact)`.

Email adapters (Gmail, Outlook) are text-only in v1 — inbound attachments come through as best-effort plain-text body extraction, and outbound media is not yet supported.

## Idempotency and storage

The hub uses a `MessageStore` for two things:

1. Saving inbound and outbound messages.
2. Deduplicating webhook deliveries by `externalId` (platforms retry on 5xx, so the same message can arrive twice).

The default in-memory store is fine for development and tests but loses state on restart. Provide your own implementation for production:

```typescript
interface MessageStore {
  saveMessage(message: UnifiedMessage): Promise<void>;
  getMessage(id: string): Promise<UnifiedMessage | null>;
  hasExternalId(channel: string, externalId: string): Promise<boolean>;
}

const hub = createHub({ store: makePostgresStore(db) });
```

## Errors

All errors thrown by msgly are plain `Error` instances tagged with `name: 'MsglyError'` plus a machine-readable `code`. Detect them with `isMsglyError`:

```typescript
import { isMsglyError, type MsglyErrorCode } from '@msgly/core';

try {
  await hub.send(/* ... */);
} catch (err) {
  if (isMsglyError(err, 'SendFailed')) {
    console.log('channel:', err.channel);
    console.log('receipt:', err.receipt);
  }
}
```

Possible codes:

| Code                      | Thrown when                                          |
| ------------------------- | ---------------------------------------------------- |
| `AdapterNotRegistered`    | `hub.send()` to a channel with no adapter            |
| `AdapterAlreadyRegistered`| `hub.register()` called twice for the same channel   |
| `UnsupportedFeature`      | `content.type` is not in adapter capabilities        |
| `InvalidSignature`        | Webhook HMAC mismatch                                |
| `SendFailed`              | `adapter.send()` failed after retries                |

Constructors are also exported for adapter authors: `adapterNotRegistered`, `unsupportedFeature`, `invalidSignature`, `sendFailed`.

## Writing a custom adapter

Implement the `Adapter` interface:

```typescript
import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  WebhookRequest,
  OutboundMessage,
  InboundMessage,
  DeliveryReceipt,
  MediaFile,
  MediaReference,
} from '@msgly/core';

interface MyConfig { apiToken: string; }

export function createMyAdapter(config: MyConfig): Adapter {
  return {
    channel: 'mychannel' as const,
    capabilities: { /* ... */ },
    async send(message: OutboundMessage): Promise<DeliveryReceipt> { /* ... */ },
    async handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> { /* ... */ },
    async verifySignature(req: WebhookRequest): Promise<boolean> { /* HMAC check */ },
    async uploadMedia(file: MediaFile): Promise<MediaReference> { /* ... */ },
    async downloadMedia(ref: MediaReference): Promise<MediaFile> { /* ... */ },
    async verifyCredentials(): Promise<CredentialsCheckResult> { /* ... */ },

    // Optional — for Meta-style GET handshake (Messenger / Instagram / WhatsApp):
    verifyWebhookChallenge(query) { /* ... */ return null; },

    // Optional — for platforms whose POST webhook must reply with a
    // specific body (Discord PING/PONG, Graph validationToken echo):
    getInteractionAck(req) {
      // return null to fall through
      // return a string → sent as application/json
      // return { body, contentType } for non-JSON responses (text/plain etc.)
      return null;
    },

    // Optional — send a typing indicator (implement when the platform supports it):
    async sendTyping(contact: ContactRef) { /* e.g. sendChatAction(contact.channelUserId, 'typing') */ },

    // Optional lifecycle hooks:
    async start() { /* ... */ },
    async stop() { /* ... */ },
  };
}
```

Adding a new `ChannelName` requires extending the union in `core/src/types.ts` — `'mychannel'` won't compile until you do.

## Runtime compatibility

`@msgly/core` and every adapter use only Web Standard APIs:

- **`fetch`** (no `undici`, no `node-fetch`)
- **Web Crypto** (`globalThis.crypto.subtle`) for HMAC signatures
- **`TextEncoder`** / **`Uint8Array`** instead of `Buffer`
- **`globalThis.crypto.randomUUID()`** for ids (with a Math.random fallback)

This means msgly runs everywhere modern JS does:

| Runtime                       | Supported |
| ----------------------------- | --------- |
| Node 18+                      | ✓         |
| Next.js Node runtime          | ✓         |
| Next.js Edge runtime          | ✓         |
| Bun / Deno                    | ✓         |
| Modern browsers (server-only adapters; not for client sends) | ✓ |

Server-side webhook handling needs the raw request bytes — most frameworks expose them; for Next.js Route Handlers, use `await req.arrayBuffer()` and pass `new Uint8Array(...)`.

## Adapters

| Channel          | Package            | Inbound auth                                  | Setup notes                                  |
| ---------------- | ------------------ | --------------------------------------------- | -------------------------------------------- |
| Telegram         | `@msgly/telegram`  | `X-Telegram-Bot-Api-Secret-Token` header      | Easiest — `@BotFather`, no business approval |
| LINE             | `@msgly/line`      | HMAC-SHA256, constant-time                    | LINE Developers console                      |
| Messenger        | `@msgly/messenger` | `X-Hub-Signature-256` HMAC                    | Needs Meta App + Facebook Page               |
| Instagram        | `@msgly/instagram` | `X-Hub-Signature-256` HMAC                    | IG Business linked to Page                   |
| WhatsApp         | `@msgly/whatsapp`  | `X-Hub-Signature-256` HMAC                    | Meta WhatsApp Cloud API                      |
| Discord          | `@msgly/discord`   | Ed25519 over `timestamp + rawBody`            | HTTP Interactions (slash commands + buttons) |
| Microsoft Teams  | `@msgly/msteams`   | RS256 JWT against Bot Framework JWKS          | Azure Bot resource + Teams channel           |
| Slack            | `@msgly/slack`     | HMAC-SHA256 `X-Slack-Signature`               | Slack App — Events API + Block Kit           |
| WeChat           | `@msgly/wechat`    | SHA-1 `signature` query param                 | WeChat Official Account (Service Account)    |
| Gmail            | `@msgly/gmail`     | RS256 OIDC JWT (or shared token)              | Pub/Sub push subscription, OAuth refresh token |
| Outlook / M365   | `@msgly/outlook`   | `clientState` shared secret, constant-time    | Graph change-notification subscription       |

> Email adapters (`gmail`, `outlook`) are text-only in v1. Each is single-mailbox (one OAuth refresh token in config = one inbox). See the per-package READMEs for setup walkthroughs.

## Documentation

Full quickstart, connection guides, and architecture overview: https://github.com/AyushJain070401/msgly

## License

MIT
