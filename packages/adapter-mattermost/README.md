# @msgly/mattermost

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

[Mattermost](https://mattermost.com) adapter for [Msgly](https://github.com/AyushJain070401/msgly) — self-hosted team chat.

```bash
npm install @msgly/core @msgly/mattermost
```

```typescript
import { createHub } from '@msgly/core';
import { createMattermostAdapter } from '@msgly/mattermost';

const mattermost = createMattermostAdapter({
  serverUrl: 'https://chat.acme.com',   // site root, NOT .../api/v4
  accessToken: process.env.MATTERMOST_BOT_TOKEN!,
  webhookToken: process.env.MATTERMOST_WEBHOOK_TOKEN!,
  defaultChannelId: process.env.MATTERMOST_CHANNEL_ID,
});

const hub = createHub().register(mattermost);
```

## Receiving: outgoing webhooks

Mattermost calls this an **outgoing webhook** (Integrations → Outgoing
Webhooks) — it fires when a message is posted in the configured channel.

**Mattermost does not sign webhook bodies.** Instead it includes the webhook's
token in the payload, so pass `webhookToken` and the adapter compares it in
constant time. Without it, anything that can reach your endpoint can forge
messages.

The adapter drops the bot's own posts, which Mattermost echoes back when the bot
is in the channel — forwarding those would loop.

## The channel is the address

In team chat the conversation is a *channel*, not a person, so
`contact.channelUserId` holds the channel id — that's where a reply goes. The
human who spoke is in `metadata.userId` / `metadata.userName`.

Reply in-thread by passing the original post id back:

```typescript
metadata: { postId: msg.metadata?.postId }
```

Resolve a channel id from names when you don't have one:

```typescript
const id = await mattermost.getChannelId('acme', 'general');
```

## Files

Mattermost attaches by **file id**, not URL, so upload first:

```typescript
const ref = await mattermost.uploadMedia({
  data: await readFile('report.pdf'),
  mimeType: 'application/pdf',
  filename: 'report.pdf',
});

await hub.send({
  channel: 'mattermost',
  /* ... */
  content: { type: 'file', mediaRef: ref, caption: 'This week' },
});
```

Uploads are scoped to a channel, so `defaultChannelId` must be set. Passing a
`url` reference fails fast rather than being silently dropped.

## Markdown

Every message renders as markdown. Use the `fmt` helpers, and `fmt.escape()` on
untrusted text you interpolate:

```typescript
import { fmt } from '@msgly/mattermost';
`${fmt.bold('Alert')}: ${fmt.escape(userSuppliedText)}`
```

## License

MIT
