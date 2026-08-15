# @msgly/googlechat

📖 **Docs & channel reference:** [https://ayushjain070401.github.io/msgly/](https://ayushjain070401.github.io/msgly/)

[Google Chat](https://chat.google.com) adapter for [Msgly](https://github.com/AyushJain070401/msgly) — service-account auth with verified Google-signed webhooks.

```bash
npm install @msgly/core @msgly/googlechat
```

```typescript
import { createHub } from '@msgly/core';
import { createGoogleChatAdapter } from '@msgly/googlechat';

const googlechat = createGoogleChatAdapter({
  serviceAccountEmail: process.env.GCHAT_CLIENT_EMAIL!,  // client_email
  privateKey: process.env.GCHAT_PRIVATE_KEY!,            // private_key
  projectNumber: process.env.GCHAT_PROJECT_NUMBER!,      // digits, not the id
  defaultSpace: 'spaces/AAAAxxxxxxx',
});
```

Both credentials come from the service account's JSON key file. `privateKey`
may contain escaped `\n` sequences — the adapter normalises them, so a value
pasted straight into an env var works.

## Auth: two-legged service account

There is no user consent step and no refresh token. The adapter signs an RS256
JWT assertion with your private key, exchanges it for an OAuth access token, and
caches it (refreshing a minute early). Concurrent refreshes collapse into a
single request.

## Verifying inbound requests

Google sends events with a bearer JWT signed by
`chat@system.gserviceaccount.com`, whose `aud` claim is your **project number**
(the digits, not the project id).

Set `projectNumber` and the adapter verifies the signature against Google's
JWKS and checks `iss`, `aud`, `exp`, and `nbf`. The `alg` is pinned to RS256, so
`alg: none` and algorithm-confusion attempts are rejected.

**Leaving `projectNumber` unset disables verification entirely** — there is
nothing to check `aud` against, so inbound requests are unauthenticated.

## The space is the address

The conversation is a *space*, so `contact.channelUserId` holds the space name
(`spaces/AAAA…`). The human who spoke is in `metadata.userId`.

Inbound text uses `argumentText`, which strips the `@bot` mention — usually what
you actually want to parse.

Reply in the same thread by passing `metadata.threadName` back. The adapter also
sets `messageReplyOption`; without it a threaded reply silently starts a **new**
thread.

Button clicks arrive as `CARD_CLICKED` events and are surfaced through
`message.interaction`, matching how other adapters report postbacks.

## Media

Chat bots cannot upload attachments through the messages API, so
`capabilities.media` is all `false` and `uploadMedia` throws with an
explanation. Share files by linking them (e.g. in Drive) instead.

## License

MIT
