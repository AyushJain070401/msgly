# @msgly/discord

> Discord HTTP Interactions adapter for [Msgly](https://github.com/AyushJain070401/msgly). Receive slash commands and button clicks, send replies through the unified hub. **Zero classes, works in Node 20.13+, Bun, Deno, Cloudflare Workers, and Edge runtimes.**

## Install

```bash
npm install @msgly/core @msgly/discord
```

## How Discord fits Msgly

Discord is the only Msgly channel that's not message-DM-shaped. Bots receive
events via two paths:

- **Gateway (WebSocket)** — every message in every channel the bot can see.
- **HTTP Interactions** — slash commands and button/select-menu clicks only.

This adapter implements **HTTP Interactions** because it fits the webhook
model Msgly is built around. If you need to react to every free-form message
in a channel (rather than to slash commands), you'll want a Gateway client
alongside Msgly. PRs for a Gateway adapter are welcome.

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createDiscordAdapter } from '@msgly/discord';

const hub = createHub();

hub.register(
  createDiscordAdapter({
    applicationId: process.env.DISCORD_APPLICATION_ID!,
    botToken: process.env.DISCORD_BOT_TOKEN!,
    publicKey: process.env.DISCORD_PUBLIC_KEY!,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: 'discord',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
      // Pass the interaction token through so the reply edits the deferred
      // response inline (no "thinking..." flicker on the user's screen).
      metadata: { interactionToken: msg.metadata?.interactionToken },
    });
  }
});

const app = express();
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

const handlers = hub.createWebhookHandler();
app.post('/webhook/:channel', handlers.post);

app.listen(3000);
```

## Config

```typescript
interface DiscordConfig {
  /** Application ID — General Information tab of your Discord app. */
  applicationId: string;
  /** Bot token from the Bot tab. */
  botToken: string;
  /** Public Key from the General Information tab (hex, 64 chars). */
  publicKey: string;
  /** Override the API base. Defaults to https://discord.com/api. */
  apiBase?: string;
  /** API version. Defaults to v10. */
  apiVersion?: string;
}
```

## Setup (15 minutes)

**1. Create an application.** Visit [discord.com/developers/applications](https://discord.com/developers/applications) → **New Application**. Give it a name.

**2. Copy three values from the dashboard:**

- **General Information** tab:
  - **Application ID** → `DISCORD_APPLICATION_ID`
  - **Public Key** → `DISCORD_PUBLIC_KEY`
- **Bot** tab:
  - Click **Reset Token** → copy immediately (Discord only shows it once) → `DISCORD_BOT_TOKEN`

**3. Register the interactions endpoint.** Back on the **General Information** tab, find the **Interactions Endpoint URL** field and paste your public URL:

```
<PUBLIC_URL>/webhook/discord
```

Click **Save Changes**. Discord will immediately PING your endpoint; if your server is running, the adapter responds with a PONG and Discord accepts the URL. If you see "validation failed", your server isn't running, the URL is wrong, or the public key is mismatched.

**4. Register a slash command.** This is a one-time HTTP call. The simplest way is via curl:

```bash
APP_ID="your_application_id"
TOKEN="your_bot_token"

curl -X POST \
  -H "Authorization: Bot $TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"name":"echo","description":"Echo what you type","options":[{"name":"msg","description":"the message","type":3,"required":true}]}' \
  "https://discord.com/api/v10/applications/$APP_ID/commands"
```

(Global commands can take up to an hour to propagate. For instant testing, use guild-scoped commands at `/applications/$APP_ID/guilds/$GUILD_ID/commands`.)

**5. Invite the bot to a server.** OAuth2 → URL Generator → scopes: `bot`, `applications.commands`. Open the generated URL, pick a server, authorize.

**6. Test.** In any channel of that server, type `/echo msg:hello`. Your bot replaces the "thinking..." placeholder with `You said: /echo msg=hello`.

## Inbound shape

Msgly normalizes Discord interactions to text messages:

| Discord interaction        | `content.text`                        |
| -------------------------- | ------------------------------------- |
| `/echo msg:hi` slash cmd   | `/echo msg=hi`                        |
| Button click `custom_id=x` | `x`                                   |
| PING (type 1)              | (no inbound message — ACK'd silently) |

Each inbound message exposes `metadata.interactionToken`, `metadata.interactionId`, `metadata.userId`, and `metadata.guildId` (when applicable) so you can route, audit, or reply.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image         | ✓ (URL)   |
| video         | ✓ (URL)   |
| audio         | ✓ (URL)   |
| file          | ✓ (URL)   |
| location      | ✓ (as map link) |
| buttons       | ✓         |
| quick replies | —         |
| reactions     | —         |
| typing        | —         |
| templates     | —         |

Media is sent by passing a public URL — Discord auto-embeds it in the message. Native multipart attachment upload is not yet implemented.

## Reply path: deferred + followup

Discord enforces a 3-second deadline on every interaction response. Msgly's webhook handler immediately ACKs with `{type: 5}` (commands) or `{type: 6}` (components), which shows users a "thinking..." placeholder. When you later call `hub.send` with `metadata.interactionToken`, the adapter PATCHes the original deferred response — the placeholder is replaced inline, no second message.

If you call `hub.send` without `metadata.interactionToken`, the adapter falls back to `POST /channels/{channel_id}/messages` using the bot token (works for any channel the bot has been invited to).

## Sending examples

### Text reply to a slash command

```typescript
await hub.send({
  channel: 'discord',
  account: msg.account,
  contact: msg.contact,
  content: { type: 'text', text: 'hello!' },
  metadata: { interactionToken: msg.metadata?.interactionToken },
});
```

### Buttons

```typescript
await hub.send({
  channel: 'discord',
  account, contact,
  content: {
    type: 'interactive',
    text: 'Pick one:',
    buttons: [
      { id: 'yes', label: 'Yes' },
      { id: 'no',  label: 'No' },
    ],
  },
  metadata: { interactionToken: msg.metadata?.interactionToken },
});
```

When the user taps a button, your `hub.on('message', ...)` handler receives a text message whose `content.text` equals the button's `id` (`"yes"` or `"no"`).

### Unsolicited message to a channel

```typescript
await hub.send({
  channel: 'discord',
  account: { channel: 'discord', channelAccountId: process.env.DISCORD_APPLICATION_ID! },
  contact: { channel: 'discord', channelUserId: 'CHANNEL_ID_HERE' },
  content: { type: 'text', text: 'announcement!' },
});
```

The bot must be a member of the channel for this to succeed.

## Runtime requirements

Ed25519 signature verification uses WebCrypto. This is native in:

- **Node 20.13+** (released May 2024)
- **Bun** (all recent versions)
- **Deno** (all recent versions)
- **Cloudflare Workers**, Vercel Edge, Netlify Edge
- Modern browsers (Chrome 113+, Firefox 130+, Safari 17+)

Node 20.12 and older lack `subtle.verify` for Ed25519 — the verification call will throw. Upgrade to Node 20.13+ (or 22.x).

## Common pitfalls

- **"Interactions Endpoint URL: validation failed"**: your server isn't running, isn't reachable at the URL you entered, or the `DISCORD_PUBLIC_KEY` doesn't match the app's actual public key. The adapter logs the verification error if you wire `hub.on('error', ...)`.
- **"Unknown interaction" error when calling `hub.send`**: the deferred ack deadline (15 min) elapsed, or you're using a stale `interactionToken`. Tokens are single-use for `@original` PATCH followed by additional followup POSTs.
- **Slash command doesn't appear in the Discord client**: global commands propagate slowly (up to 1 hour). For development, register against a specific guild — those are instant.
- **"401 Unauthorized" on send**: your bot token was reset in the dashboard. Re-copy and update `DISCORD_BOT_TOKEN`.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
