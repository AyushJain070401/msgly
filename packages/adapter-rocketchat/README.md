# @msgly/rocketchat

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

[Rocket.Chat](https://rocket.chat) adapter for [Msgly](https://github.com/AyushJain070401/msgly) — self-hosted team chat.

```bash
npm install @msgly/core @msgly/rocketchat
```

```typescript
import { createHub } from '@msgly/core';
import { createRocketChatAdapter } from '@msgly/rocketchat';

const rocketchat = createRocketChatAdapter({
  serverUrl: 'https://chat.acme.com',    // site root, NOT .../api/v1
  authToken: process.env.RC_AUTH_TOKEN!,
  userId: process.env.RC_USER_ID!,       // required alongside the token
  webhookToken: process.env.RC_WEBHOOK_TOKEN!,
  defaultRoomId: process.env.RC_ROOM_ID,
});
```

## Auth needs both values

Rocket.Chat authenticates with an `X-Auth-Token` / `X-User-Id` **pair** — a
token alone is rejected. Both are shown together when you create a personal
access token under My Account → Personal Access Tokens, and an admin must have
enabled them under Admin → Accounts.

## `success: false` is the real result

Rocket.Chat often returns **HTTP 200 with `success: false`** for errors. The
adapter treats the flag as authoritative, so a rejected message returns a failed
receipt instead of a false success.

## Receiving: outgoing webhooks

Configure Integrations → Outgoing WebHook. Rocket.Chat **does not sign** the
body; it includes the integration's token in the payload, so set `webhookToken`
and the adapter compares it in constant time. Posts marked `bot` are dropped —
forwarding the integration's own output would loop.

## The room is the address

The conversation is a *room*, so `contact.channelUserId` holds the room id —
that's where a reply goes. The human who spoke is in `metadata.userId` /
`metadata.userName`. Reply in-thread by passing `metadata.messageId` back
(the adapter maps it to `tmid`).

Resolve a room id from a channel name:

```typescript
const id = await rocketchat.getRoomId('general');
```

## Media

`chat.postMessage` **links** media by URL rather than uploading it, so pass a
`url` reference. For a genuine upload use `uploadMedia`, which posts through
`rooms.upload` into `defaultRoomId`.

## Markdown

Note Rocket.Chat uses **single** asterisks for bold (`*bold*`), unlike
Mattermost and Slack. Use the exported `fmt` helpers, and `fmt.escape()` on
untrusted text.

## License

MIT
