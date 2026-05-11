# @msgly/gmail

> Gmail adapter for [Msgly](https://github.com/AyushJain070401/msgly). Receive new messages as `hub.on('message')` events via Google Cloud Pub/Sub push, send threaded replies via the Gmail REST API. **Built for "agent on email channel" use cases — one bot mailbox, OAuth refresh token, pure WebCrypto.**

## Scope (v1)

This release ships **text-only send + receive** for a **single mailbox per adapter** (the bot's own inbox). It is the right shape for shared support inboxes, reply-bots, and agent automations on a dedicated mailbox.

Out of scope for v1 — these are planned, but absent today:
- Sending attachments / inline images
- Surfacing inbound attachments as media (the body text comes through; attachment bytes are not extracted)
- Multi-user mailbox routing (one adapter = one mailbox)
- Reading historical mail (only push-triggered fetch)

## Install

```bash
npm install @msgly/core @msgly/gmail
```

## How Gmail receive works

Gmail does not push email bodies to webhooks. The flow is:

1. You call `users.watch()` **once** with a Pub/Sub topic name. Gmail starts publishing notifications to that topic whenever the inbox changes.
2. Your Pub/Sub push subscription forwards each event to your webhook (`<PUBLIC_URL>/webhook/gmail`). The payload contains `{ emailAddress, historyId }` — just the historyId, no message body.
3. The adapter calls `users.history.list` from the previously-seen historyId, finds new message ids, fetches each via `users.messages.get?format=full`, and emits an inbound message per item.

The "last seen historyId" is held in adapter memory. On first notification after process boot, the adapter falls back to fetching recent unread INBOX messages so nothing is lost across deploys.

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createGmailAdapter } from '@msgly/gmail';

const hub = createHub();

hub.register(
  createGmailAdapter({
    clientId: process.env.GMAIL_CLIENT_ID!,
    clientSecret: process.env.GMAIL_CLIENT_SECRET!,
    refreshToken: process.env.GMAIL_REFRESH_TOKEN!,
    emailAddress: process.env.GMAIL_EMAIL!,
    pushAuth: {
      kind: 'jwt',
      expectedAudience: 'https://yourdomain.com/webhook/gmail',
    },
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: 'gmail',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `Auto-reply: I received "${msg.content.text}"` },
      // Thread the reply onto the original conversation.
      metadata: {
        threadId: msg.metadata?.threadId,
        messageId: msg.metadata?.messageId,
        subject: msg.metadata?.subject,
        references: msg.metadata?.references,
      },
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
interface GmailConfig {
  /** OAuth client (Google Cloud Console → Credentials → OAuth 2.0 Client ID). */
  clientId: string;
  clientSecret: string;
  /**
   * Long-lived refresh token for the agent mailbox. Run the OAuth consent
   * flow once with `prompt=consent&access_type=offline` to obtain.
   */
  refreshToken: string;
  /** The mailbox email (used as From: and account.channelAccountId). */
  emailAddress: string;

  /** How to verify inbound Pub/Sub webhooks. Pick one. */
  pushAuth:
    | { kind: 'jwt'; expectedAudience: string; expectedServiceAccountEmail?: string }
    | { kind: 'token'; token: string }
    | { kind: 'none' };  // dev only — DO NOT use in production

  maxMessagesPerNotification?: number;  // default 25
  // overrides for testing / private clouds:
  tokenUrl?: string;
  apiBase?: string;
  jwksUrl?: string;
  clockSkewSec?: number;  // default 300
}
```

## Setup (one-time, ~30 minutes)

The setup is more involved than the chat channels because Pub/Sub needs to be wired up. Walk through it once and the runtime is just two env vars + a webhook URL.

### 1. Create an OAuth client

[Google Cloud Console](https://console.cloud.google.com/apis/credentials):

- **APIs & Services → Library** → enable **Gmail API**
- **APIs & Services → OAuth consent screen** → External or Internal — fill in basics, add scope `https://www.googleapis.com/auth/gmail.modify`. Add the bot's email as a test user.
- **Credentials → Create credentials → OAuth client ID** → Web application → add `http://localhost:8080/oauth-callback` (or whatever you'll use) as a redirect URI
- Copy **Client ID** → `GMAIL_CLIENT_ID`
- Copy **Client secret** → `GMAIL_CLIENT_SECRET`

### 2. Get a refresh token for the agent mailbox

Run the consent flow once. Quickest path locally:

```bash
# Open in your browser, signed in as the agent mailbox:
https://accounts.google.com/o/oauth2/v2/auth\
?client_id=YOUR_CLIENT_ID\
&response_type=code\
&scope=https://www.googleapis.com/auth/gmail.modify\
&redirect_uri=http://localhost:8080/oauth-callback\
&access_type=offline\
&prompt=consent
```

After consenting, you'll be redirected to your localhost URL with `?code=...`. Exchange that code for a refresh token:

```bash
curl https://oauth2.googleapis.com/token \
  -d code=THE_CODE \
  -d client_id=$GMAIL_CLIENT_ID \
  -d client_secret=$GMAIL_CLIENT_SECRET \
  -d redirect_uri=http://localhost:8080/oauth-callback \
  -d grant_type=authorization_code
```

Copy `refresh_token` from the JSON response → `GMAIL_REFRESH_TOKEN`.

> Note: Google issues a refresh token **only on the first consent**. If you need to re-issue, revoke the app at [myaccount.google.com/permissions](https://myaccount.google.com/permissions) and consent again.

### 3. Create the Pub/Sub topic and subscription

In the same Google Cloud project:

- **Pub/Sub → Topics → Create topic** — name it `gmail-inbox` (or anything).
- On the topic → **Permissions** → **Add principal** → `gmail-api-push@system.gserviceaccount.com` → role `Pub/Sub Publisher`. **This is what lets Gmail publish into your topic.**
- **Subscriptions → Create subscription** on that topic:
  - Delivery type: **Push**
  - Endpoint: `<PUBLIC_URL>/webhook/gmail`
  - **Authentication** (recommended): tick "Enable authentication", create or pick a service account, and set audience to `<PUBLIC_URL>/webhook/gmail` (this matches `pushAuth.expectedAudience` in your config).
  - Or simpler-but-less-secure: append `?token=YOUR_RANDOM_SECRET` to the endpoint URL and use `pushAuth: { kind: 'token', token: '...' }` instead.

### 4. Call `watch()` on the mailbox

Once at deploy time (and on a periodic schedule — watches expire after ~7 days):

```typescript
const adapter = createGmailAdapter({ /* ... */ });
hub.register(adapter);

await adapter.watch('projects/your-project-id/topics/gmail-inbox');
// Returns { historyId } — the baseline.
```

Schedule a cron to call `watch()` daily so the subscription never expires.

### 5. Test

Send an email to the agent mailbox from another account. Your `hub.on('message')` handler should receive it.

## Inbound shape

| Email field           | msgly mapping                                         |
| --------------------- | ----------------------------------------------------- |
| From `<addr>`         | `contact.channelUserId`                               |
| From "Name"           | `contact.displayName`                                 |
| To (bot's address)    | `account.channelAccountId`                            |
| text/plain body       | `content.text`                                        |
| Subject               | `metadata.subject`                                    |
| Message-ID            | `metadata.messageId`                                  |
| Gmail threadId        | `metadata.threadId`                                   |
| References            | `metadata.references`                                 |
| internalDate          | `timestamp`                                           |

When inbound has only HTML, the adapter strips tags into a best-effort plain-text body. Attachments are not yet surfaced as `MediaContent` (planned for v2).

## Reply path

Pass any combination of these through `metadata` and the adapter does the right thing:

| metadata field    | Effect on outbound                                           |
| ----------------- | ------------------------------------------------------------ |
| `threadId`        | Sent in the API call body — Gmail keeps the reply in-thread. |
| `messageId`       | Becomes the `In-Reply-To` header on the outgoing email.      |
| `references`      | Becomes the `References` header (chain preservation).        |
| `subject`         | Used (with auto `Re:` prefix) as the reply subject.          |

Without any of these, the adapter still sends — just as a fresh email with subject `(no subject)` to the contact address.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image / video / audio / file | — (v2) |
| location      | —         |
| buttons       | —         |
| reactions     | —         |
| typing        | —         |
| templates     | —         |

## Common pitfalls

- **No notifications arriving**: confirm the Pub/Sub topic grants `gmail-api-push@system.gserviceaccount.com` publish access. Confirm `users.watch()` returned a `historyId` (didn't error). Watches expire after ~7 days — schedule a daily re-call.
- **`401 unauthorized` on the webhook**: if you used `pushAuth: { kind: 'jwt' }`, the Pub/Sub subscription must have authentication enabled and the audience must match `expectedAudience` exactly (case-sensitive, no trailing slash mismatch).
- **`invalid_grant` from the token endpoint**: refresh token revoked or never had `access_type=offline`. Re-run consent with `prompt=consent`.
- **Inbound shows wrong sender**: this adapter parses `From:` as `"Name" <addr>` or bare address. Exotic header forms (group syntax, etc.) fall back to the raw header — file a bug if you hit one.
- **Reply doesn't thread correctly in some clients**: pass through both `metadata.threadId` AND `metadata.messageId`. Gmail uses threadId; other clients honor In-Reply-To.

## Documentation

Full multi-channel docs: https://github.com/AyushJain070401/msgly

## License

MIT
