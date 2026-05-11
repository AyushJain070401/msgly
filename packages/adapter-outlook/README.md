# @msgly/outlook

> Outlook / Microsoft 365 mail adapter for [Msgly](https://github.com/AyushJain070401/msgly). Receive new messages via Microsoft Graph change-notifications, send threaded replies via `/me/messages/{id}/reply`. **Built for "agent on email channel" use cases — one bot mailbox, OAuth refresh token, pure WebCrypto-free verification (no signing — `clientState` shared secret).**

## Scope (v1)

This release ships **text-only send + receive** for a **single mailbox per adapter**. Out of scope (planned):
- Sending attachments / inline images
- Surfacing inbound attachments as media (body comes through; attachment bytes are not extracted)
- Multi-user mailbox routing
- Reading historical mail (only push-triggered fetch)

## Install

```bash
npm install @msgly/core @msgly/outlook
```

## How Outlook receive works

Microsoft Graph pushes change-notifications (no body) when a new email lands in the agent's inbox. The flow:

1. You call `createSubscription({ notificationUrl })` **once** at deploy time. Graph performs a validation handshake — it POSTs `?validationToken=xxx` to your URL and expects you to echo `xxx` back as `text/plain`. The adapter handles this automatically via `getInteractionAck`.
2. When new mail arrives, Graph POSTs `{ value: [{ resourceData: { id }, clientState, ... }] }` to your URL. The adapter verifies `clientState` matches your configured secret, then fetches `/me/messages/{id}` and emits an inbound message.
3. Subscriptions expire — message subscriptions max out at **4230 minutes (≈3 days)**. Schedule a `renewSubscription` cron, or recreate on each deploy.

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createOutlookAdapter } from '@msgly/outlook';

const hub = createHub();
const outlook = createOutlookAdapter({
  clientId: process.env.OUTLOOK_CLIENT_ID!,
  clientSecret: process.env.OUTLOOK_CLIENT_SECRET!,
  refreshToken: process.env.OUTLOOK_REFRESH_TOKEN!,
  emailAddress: process.env.OUTLOOK_EMAIL!,
  clientState: process.env.OUTLOOK_CLIENT_STATE!,
  tenantId: 'common',  // or your tenant GUID
});
hub.register(outlook);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: 'outlook',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `Auto-reply: I received "${msg.content.text}"` },
      // Pass messageId so Graph uses /reply and preserves the conversation thread.
      metadata: {
        messageId: msg.metadata?.messageId,
        subject: msg.metadata?.subject,
      },
    });
  }
});

const app = express();
app.use(express.json({ verify: (req, _r, buf) => ((req as any).rawBody = new Uint8Array(buf)) }));

const handlers = hub.createWebhookHandler();
app.post('/webhook/:channel', handlers.post);

app.listen(3000, async () => {
  // One-time subscription setup. In production, idempotent (delete-then-create
  // or store the subscriptionId and skip if present).
  await outlook.createSubscription({
    notificationUrl: 'https://yourdomain.com/webhook/outlook',
  });
});
```

## Config

```typescript
interface OutlookConfig {
  clientId: string;
  clientSecret: string;
  /** 'common' for multi-tenant, GUID for single-tenant. Default: 'common'. */
  tenantId?: string;
  /**
   * Refresh token obtained via OAuth auth-code flow with scopes
   * `Mail.Read Mail.Send offline_access` and `prompt=consent`.
   */
  refreshToken: string;
  /** The mailbox UPN (acts as account.channelAccountId). */
  emailAddress: string;
  /**
   * Shared secret echoed in every notification's `clientState`. Pick any
   * random string. The adapter rejects notifications whose `clientState`
   * doesn't match.
   */
  clientState: string;

  tokenUrl?: string;
  graphBase?: string;
}
```

## Setup (one-time, ~20 minutes)

### 1. Register an Entra ID app

[portal.azure.com](https://portal.azure.com) → **Entra ID → App registrations → New registration**:

- Single tenant or multi-tenant (multi-tenant if your agent will be installed across orgs)
- Redirect URI: Web → `http://localhost:8080/oauth-callback` (or similar)
- After creation: **Application (client) ID** → `OUTLOOK_CLIENT_ID`
- **Certificates & secrets → New client secret** → copy the Value immediately → `OUTLOOK_CLIENT_SECRET`
- **API permissions → Add a permission → Microsoft Graph → Delegated permissions**: add `Mail.Read`, `Mail.Send`, `offline_access`. Click **Grant admin consent** if you're admin.

### 2. Get a refresh token

```bash
# Open in browser, signed in as the agent mailbox:
https://login.microsoftonline.com/common/oauth2/v2.0/authorize\
?client_id=YOUR_CLIENT_ID\
&response_type=code\
&redirect_uri=http://localhost:8080/oauth-callback\
&scope=Mail.Read%20Mail.Send%20offline_access\
&prompt=consent
```

Consent, grab the `?code=...` from the redirect, exchange it:

```bash
curl https://login.microsoftonline.com/common/oauth2/v2.0/token \
  -d client_id=$OUTLOOK_CLIENT_ID \
  -d client_secret=$OUTLOOK_CLIENT_SECRET \
  -d grant_type=authorization_code \
  -d code=THE_CODE \
  -d redirect_uri=http://localhost:8080/oauth-callback
```

Copy `refresh_token` from the response → `OUTLOOK_REFRESH_TOKEN`.

### 3. Pick a clientState

Any random string — for example, `openssl rand -hex 32`. Set as `OUTLOOK_CLIENT_STATE`. The adapter uses this both when creating the subscription AND when verifying inbound notifications.

### 4. Create the subscription

Once at deploy time:

```typescript
const outlook = createOutlookAdapter({ /* ... */ });
hub.register(outlook);

const sub = await outlook.createSubscription({
  notificationUrl: 'https://yourdomain.com/webhook/outlook',
});
console.log('subscription id:', sub.id, 'expires:', sub.expirationDateTime);
```

Graph will perform the validation handshake (the adapter answers automatically) and then start pushing notifications.

### 5. Renew on a schedule

Subscriptions expire after up to 4230 minutes. Schedule a daily renew:

```typescript
await outlook.renewSubscription(sub.id);
```

## Inbound shape

| Graph Message field   | msgly mapping                                  |
| --------------------- | ---------------------------------------------- |
| `from.emailAddress.address` | `contact.channelUserId`                  |
| `from.emailAddress.name`    | `contact.displayName`                    |
| `subject`             | `metadata.subject`                             |
| `id`                  | `metadata.messageId` (and `externalId`)        |
| `conversationId`      | `metadata.conversationId`                      |
| `internetMessageId`   | `metadata.internetMessageId`                   |
| `body.content`        | `content.text` (HTML stripped if needed)       |
| `receivedDateTime`    | `timestamp`                                    |

## Reply path

Pass `metadata.messageId` and the adapter calls `POST /me/messages/{id}/reply` — Graph adds proper threading headers and keeps the conversation linked. Without it, the adapter falls back to `POST /me/sendMail` with a fresh subject/recipient.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image / video / audio / file | — (v2) |
| buttons       | —         |
| reactions     | —         |
| typing        | —         |
| templates     | —         |

## Common pitfalls

- **`createSubscription` fails with "Invalid notification URL"**: your server isn't reachable at the URL, OR didn't respond to the validation handshake (`?validationToken=xxx`) with status 200 and the token as plain text within 10 seconds. Run the example server FIRST, then call createSubscription.
- **All notifications rejected at runtime**: the `clientState` in the notification doesn't match your config. Both must be exactly equal.
- **Subscriptions silently expire**: nothing renews automatically. Schedule a daily `renewSubscription` cron or accept the ~3-day re-create cycle.
- **`AADSTS65001: consent required`**: someone in your tenant disabled user consent. An admin must grant consent for `Mail.Read` / `Mail.Send` in the app registration.
- **Refresh token expired**: refresh tokens have a default lifetime around 90 days for inactive apps. Re-run the consent flow.

## Documentation

Full multi-channel docs: https://github.com/AyushJain070401/msgly

## License

MIT
