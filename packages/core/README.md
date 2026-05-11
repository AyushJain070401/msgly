# @msgly/core

> Core engine for Msgly — unified message model, the `MessagingHub` orchestrator, retry, idempotency, capability checks, and the `Adapter` contract every channel package implements.

`@msgly/core` is the runtime every channel adapter plugs into. You won't usually depend on it directly for application code — install it alongside one or more adapters (`@msgly/telegram`, `@msgly/whatsapp`, `@msgly/line`, `@msgly/messenger`, `@msgly/instagram`).

## Install

```bash
npm install @msgly/core
```

## Quick start

```typescript
import express from 'express';
import { MessagingHub } from '@msgly/core';
import { TelegramAdapter } from '@msgly/telegram';
import { WhatsAppAdapter } from '@msgly/whatsapp';

const hub = new MessagingHub();

hub.register(new TelegramAdapter({
  botToken: process.env.TELEGRAM_BOT_TOKEN!,
  webhookSecret: process.env.TELEGRAM_WEBHOOK_SECRET!,
}));

hub.register(new WhatsAppAdapter({
  phoneNumberId: process.env.WA_PHONE_ID!,
  accessToken: process.env.WA_TOKEN!,
  appSecret: process.env.META_APP_SECRET!,
  verifyToken: process.env.META_VERIFY_TOKEN!,
}));

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
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = buf) }));

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
  account: AccountRef;         // your business identity on that channel
  contact: ContactRef;         // the end user
  content: MessageContent;     // discriminated union, see below
  timestamp: string;           // ISO 8601
  direction: 'inbound' | 'outbound';
  metadata?: Record<string, unknown>;
  raw?: unknown;               // present on inbound — original platform payload
}
```

### Content types

`MessageContent` is a discriminated union:

```typescript
type MessageContent =
  | { type: 'text'; text: string }
  | { type: 'image' | 'video' | 'audio' | 'file';
      mediaRef: MediaReference; caption?: string }
  | { type: 'location'; latitude: number; longitude: number; name?: string; address?: string }
  | { type: 'interactive'; text: string; buttons: { id: string; label: string }[] }
  | { type: 'template'; templateName: string; language: string;
      variables?: Record<string, string> };
```

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

## `MessagingHub`

```typescript
new MessagingHub(options?: MessagingHubOptions)

interface MessagingHubOptions {
  store?: MessageStore;             // default: InMemoryStore
  logger?: pino.Logger;             // default: pino({ name: 'chatterbox' })
  retry?: Partial<RetryOptions>;    // default: 3 attempts, 500ms base, 8000ms cap
}
```

### `hub.register(adapter)`

Registers a channel adapter. Throws if the same channel is registered twice. Returns `this` for chaining.

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

### `hub.on(event, handler)`

```typescript
hub.on('message',  (msg: InboundMessage) => { /* handle inbound */ });
hub.on('delivery', (receipt: DeliveryReceipt) => { /* status updates */ });
hub.on('error',    (err: Error, ctx?: object) => { /* observe failures */ });
```

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
- `POST /webhook/:channel` — verifies HMAC signature, dispatches to the right adapter, deduplicates via `externalId`, emits `message` events

```typescript
const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);
```

> **Raw body is required.** Signature verification needs the byte-exact request body. Configure your JSON parser to expose it on `req.rawBody` — for Express: `express.json({ verify: (req, _r, buf) => (req.rawBody = buf) })`.

### `hub.handleWebhook(channel, req)`

The lower-level entry point used by `createWebhookHandler`. Useful when wiring webhooks into a framework that doesn't fit the Express shape.

### `hub.channels`

Returns the list of registered channel names.

### `hub.getAdapter(channel)`

Returns the registered adapter, or throws `AdapterNotRegisteredError`.

### `hub.start()` / `hub.stop()`

Calls the optional `start()`/`stop()` lifecycle hooks on every registered adapter (used by adapters that need to do work outside the request cycle).

## Retry

Sends are wrapped in exponential backoff with **equal jitter**:

- `maxAttempts: 3` (configurable)
- `initialDelayMs: 500`
- `maxDelayMs: 8000`
- Backoff: `min(initial * 2^(attempt-1), maxDelay)` then `delay/2 + random(delay/2)`

Auth errors (401/403/404) and "unauthorized" codes are **never** retried — the token is bad, retrying just wastes API calls. Network errors and 5xx are retried.

```typescript
const hub = new MessagingHub({
  retry: {
    maxAttempts: 5,
    initialDelayMs: 200,
    maxDelayMs: 4000,
    shouldRetry: (err, attempt) => attempt < 3, // your own policy
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

The hub checks `content.type` against these before dispatching to the adapter. Unsupported sends throw `UnsupportedFeatureError`:

```typescript
import { UnsupportedFeatureError } from '@msgly/core';

try {
  await hub.send({ channel: 'instagram', /* ... */ content: { type: 'audio', mediaRef } });
} catch (err) {
  if (err instanceof UnsupportedFeatureError) {
    // Instagram does not support audio
  }
}
```

Cross-channel matrix:

| Feature        | Telegram | WhatsApp | LINE | Messenger | Instagram |
| -------------- | -------- | -------- | ---- | --------- | --------- |
| text           | ✓        | ✓        | ✓    | ✓         | ✓         |
| image          | ✓        | ✓        | ✓    | ✓         | ✓         |
| video          | ✓        | ✓        | ✓    | ✓         | ✓         |
| audio          | ✓        | ✓        | ✓    | ✓         | —         |
| file           | ✓        | ✓        | —    | ✓         | —         |
| buttons        | ✓        | ✓        | ✓    | ✓         | —         |
| quick replies  | ✓        | ✓        | ✓    | ✓         | ✓         |
| templates      | —        | ✓        | —    | —         | —         |
| reactions      | ✓        | ✓        | —    | —         | ✓         |
| typing         | ✓        | —        | —    | ✓         | —         |

## Idempotency and storage

The hub uses a `MessageStore` for two things:

1. Saving inbound and outbound messages.
2. Deduplicating webhook deliveries by `externalId` (platforms retry on 5xx, so the same message can arrive twice).

The default `InMemoryStore` is fine for development and tests but loses state on restart. Provide your own implementation for production:

```typescript
interface MessageStore {
  saveMessage(message: UnifiedMessage): Promise<void>;
  getMessage(id: string): Promise<UnifiedMessage | null>;
  hasExternalId(channel: string, externalId: string): Promise<boolean>;
}

const hub = new MessagingHub({ store: new PostgresStore(db) });
```

## Errors

All errors extend `MessagingHubError`:

```typescript
import {
  MessagingHubError,
  AdapterNotRegisteredError,   // hub.send() to a channel with no adapter
  UnsupportedFeatureError,     // content.type not in adapter.capabilities
  InvalidSignatureError,       // webhook HMAC mismatch
  SendFailedError,             // adapter.send() failed after retries
} from '@msgly/core';
```

`SendFailedError` exposes `.sendCause` — either the underlying exception or the failed `DeliveryReceipt` (which carries `error.code` and `error.message`).

## Writing a custom adapter

Implement the `Adapter<TConfig>` abstract class:

```typescript
import {
  Adapter,
  type AdapterCapabilities,
  type CredentialsCheckResult,
  type WebhookRequest,
  type OutboundMessage,
  type InboundMessage,
  type DeliveryReceipt,
  type MediaFile,
  type MediaReference,
} from '@msgly/core';

interface MyConfig { apiToken: string; }

class MyAdapter extends Adapter<MyConfig> {
  readonly channel = 'mychannel' as const;
  readonly capabilities: AdapterCapabilities = { /* ... */ };

  async send(message: OutboundMessage): Promise<DeliveryReceipt> { /* ... */ }
  async handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> { /* ... */ }
  verifySignature(req: WebhookRequest): boolean { /* HMAC check */ }
  async uploadMedia(file: MediaFile): Promise<MediaReference> { /* ... */ }
  async downloadMedia(ref: MediaReference): Promise<MediaFile> { /* ... */ }
  async verifyCredentials(): Promise<CredentialsCheckResult> { /* ... */ }

  // Optional — for Meta-style GET handshake:
  verifyWebhookChallenge?(query): string | null { /* ... */ }

  // Optional lifecycle hooks:
  async start?(): Promise<void> { /* ... */ }
  async stop?(): Promise<void> { /* ... */ }
}
```

Adding a new `ChannelName` requires extending the union in `core/src/types.ts` — `'mychannel'` won't compile until you do.

## Adapters

| Channel    | Package              |
| ---------- | -------------------- |
| Telegram   | `@msgly/telegram`    |
| LINE       | `@msgly/line`        |
| Messenger  | `@msgly/messenger`   |
| Instagram  | `@msgly/instagram`   |
| WhatsApp   | `@msgly/whatsapp`    |

## Documentation

Full quickstart, connection guides, and architecture overview: https://github.com/AyushJain070401/chatterbox

## License

MIT
