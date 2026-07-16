# @msgly/slack

> Slack Events API adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive Slack messages through the unified hub — text, images, Block Kit buttons, interactive button clicks. **Zero classes, runs in Node, Next.js, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/slack
```

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createSlackAdapter } from '@msgly/slack';

const hub = createHub();

hub.register(
  createSlackAdapter({
    botToken: process.env.SLACK_BOT_TOKEN!,
    signingSecret: process.env.SLACK_SIGNING_SECRET!,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.channel === 'slack' && msg.content.type === 'text') {
    await hub.send({
      channel: 'slack',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
    });
  }
});

const app = express();
// Both JSON and form-encoded bodies are handled by the adapter
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));
app.use(express.urlencoded({ extended: true, verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

const handlers = hub.createWebhookHandler();
app.get('/webhook/:channel', handlers.get);
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Config

```typescript
interface SlackConfig {
  /** Bot token starting with xoxb-. */
  botToken: string;

  /** Signing secret from App Settings → Basic Information → App Credentials. */
  signingSecret: string;

  /** Override for tests. Defaults to https://slack.com/api. */
  apiBase?: string;
}
```

## Setup (10 minutes)

1. Create an app at [api.slack.com/apps](https://api.slack.com/apps) → **Create New App** → From scratch.
2. **Add Bot Token Scopes** (OAuth & Permissions → Bot Token Scopes):
   - `chat:write` — send messages
   - `channels:history` / `im:history` — read messages in channels/DMs
3. **Install to Workspace** (OAuth & Permissions → Install to Workspace). Copy the **Bot User OAuth Token** (`xoxb-...`).
4. **Copy Signing Secret** from Basic Information → App Credentials → Signing Secret.
5. Set environment variables:
   ```bash
   SLACK_BOT_TOKEN=xoxb-...
   SLACK_SIGNING_SECRET=...
   ```
6. **Enable Events** (Event Subscriptions → Enable Events):
   - Request URL: `<PUBLIC_URL>/webhook/slack`
   - Subscribe to bot events: `message.channels`, `message.im`, `app_mention`
7. **Enable Interactivity** (Interactivity & Shortcuts → Enable):
   - Request URL: `<PUBLIC_URL>/webhook/slack`
   - This is the same URL — the adapter auto-detects event type vs interaction.
8. Reinstall the app to your workspace after adding scopes.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image (URL)   | ✓         |
| video         | —         |
| audio         | —         |
| file          | —         |
| location      | ✓ (text)  |
| buttons       | ✓         |
| quick replies | —         |
| reactions     | —         |
| typing        | —         |
| templates     | —         |

`typing` is listed as unsupported because Slack has no native indicator for
bots — see [Beyond `send()`](#beyond-send-editing-messages-response_url-threads)
above for the "thinking…" placeholder pattern and the native Assistant status API.

## Sending examples

### Formatted text (mrkdwn)

```typescript
import { fmt } from '@msgly/slack';

await hub.send({
  channel: 'slack',
  account, contact,
  content: {
    type: 'text',
    format: 'markdown',   // renders as mrkdwn block
    text: `${fmt.bold('Order confirmed')} — tracking: ${fmt.code('TRK-1234')}\n${fmt.link('Track it', 'https://track.example.com')}`,
  },
});
```

Available helpers: `bold` (`*text*`), `italic` (`_text_`), `strikethrough` (`~text~`), `code` (`` `text` ``), `codeBlock` (` ```block``` `), `link` (`<url|text>`).

### Image

```typescript
await hub.send({
  channel: 'slack',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/chart.png' },
    caption: 'Monthly sales',
  },
});
```

Images must be public HTTPS URLs. Slack renders them as image blocks.

### Buttons (Block Kit)

```typescript
await hub.send({
  channel: 'slack',
  account, contact,
  content: {
    type: 'interactive',
    text: 'How can I help?',
    buttons: [
      { id: 'track', label: 'Track order' },
      { id: 'return', label: 'Return item' },
      { id: 'help', label: 'Other' },
    ],
  },
});
```

When the user clicks a button, `hub.on('message', ...)` receives a message with `content.text` equal to the button's `value` and an `interaction` field:

```typescript
hub.on('message', async (msg) => {
  if (msg.interaction) {
    console.log('button clicked:', msg.interaction.data); // button id
  }
});
```

### Multi-row buttons

Pass a 2D array to get multiple action rows (up to 5 buttons per row):

```typescript
await hub.send({
  channel: 'slack',
  account, contact,
  content: {
    type: 'interactive',
    text: 'Select a plan:',
    buttons: [
      [{ id: 'free', label: 'Free' }, { id: 'pro', label: 'Pro' }],
      [{ id: 'enterprise', label: 'Enterprise' }],
    ],
  },
});
```

## Beyond `send()`: editing messages, response_url, threads

The unified `send()` / `handleWebhook()` contract covers posting and receiving
messages, but Slack's richer interaction patterns need direct Web API calls.
`createSlackAdapter` exposes a few extra methods for this — grab the
concrete adapter instance (the one you passed to `hub.register`) to call them.

### Echo the button choice, then remove the buttons

When a button is clicked, the inbound message carries the interaction's
`response_url` at `msg.metadata.responseUrl`. Post back through it to replace
the original message (buttons and all):

```typescript
hub.on('message', async (msg) => {
  if (msg.interaction && msg.metadata?.responseUrl) {
    await slack.respondToInteraction(msg.metadata.responseUrl as string, {
      text: `You asked: ${msg.interaction.data}`,
      replaceOriginal: true, // swaps out the original message, buttons included
    });
  }
});
```

`slack` here is the object returned by `createSlackAdapter(...)`.

### "Thinking…" placeholder, then update with the real answer

Slack bots have no native typing indicator — post a placeholder message,
keep its `ts` (returned as `externalId`), then edit it in place with
`chat.update` once the answer is ready:

```typescript
hub.on('message', async (msg) => {
  const placeholder = await hub.send({
    channel: 'slack',
    account: msg.account,
    contact: msg.contact,
    content: { type: 'text', text: '⏳ Eshal AI is typing…' },
  });

  const answer = await getAnswer(msg); // however you generate the reply

  await slack.updateMessage({
    channel: msg.contact.channelUserId,
    ts: placeholder.externalId!,
    text: answer,
  });
});
```

### Reply in a thread

Pass the parent message's `ts` as `metadata.threadTs` on the outbound
message — `send()` forwards it as Slack's `thread_ts`. To keep a whole
conversation threaded, forward the inbound message's own
`metadata.threadTs` (set automatically when the incoming event/interaction
was itself inside a thread), falling back to its `externalId` for the first
reply:

```typescript
hub.on('message', async (msg) => {
  await hub.send({
    channel: 'slack',
    account: msg.account,
    contact: msg.contact,
    content: { type: 'text', text: 'Replying in-thread' },
    metadata: { threadTs: (msg.metadata?.threadTs as string) ?? msg.externalId },
  });
});
```

### Native Slack AI Assistant status (`assistant.threads.setStatus`)

For the full native "is thinking…" experience — a dedicated assistant pane
and suggested-prompt chips — configure the app as an **Assistant** (Agents &
Assistants feature, App Settings → Features → Agents & Assistants at
api.slack.com; this part can't be done from code) and subscribe to the
`assistant_thread_started` / `assistant_thread_context_changed` events. The
adapter parses those into inbound messages with
`msg.metadata.slackEvent`/`threadTs`/`channelId`, and exposes the matching
Web API calls:

```typescript
hub.on('message', async (msg) => {
  if (msg.metadata?.slackEvent === 'assistant_thread_started') {
    const { channelId, threadTs } = msg.metadata as { channelId: string; threadTs: string };
    await slack.setAssistantSuggestedPrompts({
      channelId,
      threadTs,
      prompts: [{ title: 'What is Katonic AI?', message: 'What is Katonic AI?' }],
    });
  }
});

// While generating a reply in an assistant thread:
await slack.setAssistantStatus({ channelId, threadTs, status: 'is thinking...' });
```

## Webhook setup notes

- The adapter handles **both** `application/json` (event callbacks) and `application/x-www-form-urlencoded` (interactions) on the same URL. Configure Interactivity and Events to the same endpoint.
- You must capture `rawBody` **before** Express parses the body. The snippet in Quick Start shows both `express.json` and `express.urlencoded` with a `verify` hook.
- Slack requires a **200 response within 3 seconds** for interaction payloads. The hub sends the ack immediately and processes the event out-of-band — keep your `hub.on('message')` handler fast or offload work to a queue.

## Common pitfalls

- **Events not arriving**: the bot must be in the channel. Invite it with `/invite @your-bot`.
- **Duplicate messages**: Slack retries if your server doesn't return 200 fast enough. Ensure `rawBody` capture is set up and your server starts within the 3 s limit.
- **`missing_scope` error**: add the required scope in OAuth & Permissions, then reinstall the app.
- **Signature verification failing**: ensure `rawBody` is the exact bytes before JSON parsing. Never stringify the parsed body back.
- **`url_verification` challenge fails**: Slack sends a JSON POST. Ensure `express.json()` is registered and `rawBody` is captured.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
