# @msgly/msteams

> Microsoft Teams (Bot Framework) adapter for [Msgly](https://github.com/AyushJain070401/msgly). Send and receive Teams messages through the unified hub. **Zero classes, zero runtime deps — pure WebCrypto for JWT verification.**

## Install

```bash
npm install @msgly/core @msgly/msteams
```

## How Teams fits Msgly

Teams bots run on the **Bot Framework Connector**. Each inbound message is a JSON `Activity` object, signed by Microsoft with an RS256 JWT, posted to your bot's messaging endpoint. Outbound replies are POSTed back to a region-specific `serviceUrl` (provided on each inbound activity) with an OAuth2 access token your bot fetches from Microsoft's identity platform.

This adapter handles:

- RS256 JWT verification against the Bot Framework JWKS (24h cache + rotation)
- OAuth2 client-credentials token caching (refresh ~1 min before expiry)
- Bidirectional Activity translation (text, image, file, hero-card buttons)

## Quick start

```typescript
import express from 'express';
import { createHub } from '@msgly/core';
import { createMsTeamsAdapter } from '@msgly/msteams';

const hub = createHub();

hub.register(
  createMsTeamsAdapter({
    appId: process.env.MSTEAMS_APP_ID!,
    appPassword: process.env.MSTEAMS_APP_PASSWORD!,
  }),
);

await hub.connect({ throwOnFailure: true });

hub.on('message', async (msg) => {
  if (msg.content.type === 'text') {
    await hub.send({
      channel: 'msteams',
      account: msg.account,
      contact: msg.contact,
      content: { type: 'text', text: `You said: ${msg.content.text}` },
      // CRITICAL: serviceUrl is regional — pass it through from the inbound
      // activity. Without it, send() fails.
      metadata: { serviceUrl: msg.metadata?.serviceUrl },
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
interface MsTeamsConfig {
  /** Microsoft App ID (GUID). From Azure portal → Bot resource → Configuration. */
  appId: string;
  /** Client secret. From Azure AD → App registrations → Certificates & secrets. */
  appPassword: string;

  // --- overrides (you usually don't need these) ---
  /** JWKS URL for verifying inbound JWTs. Default: Bot Framework public JWKS. */
  jwksUrl?: string;
  /** OAuth2 token endpoint. Default: multi-tenant Bot Framework endpoint. */
  tokenUrl?: string;
  /** OAuth2 scope. Default: https://api.botframework.com/.default. */
  tokenScope?: string;
  /** Expected JWT `iss`. Default: https://api.botframework.com. */
  expectedIssuer?: string;
  /** JWKS cache TTL in ms. Default: 24h. */
  jwksTtlMs?: number;
  /** Allowed clock skew (sec) for exp/nbf. Default: 300. */
  clockSkewSec?: number;
}
```

## Setup (20 minutes)

**Prerequisite:** an Azure subscription. The free tier covers Bot Service usage for development.

**1. Register an Azure AD app.** [portal.azure.com](https://portal.azure.com) → **Azure Active Directory** → **App registrations** → **New registration**. Single tenant or multi-tenant — multi-tenant is required if your bot will be installed across orgs.

- Note the **Application (client) ID** → `MSTEAMS_APP_ID`
- Go to **Certificates & secrets** → **New client secret** → copy the **Value** immediately (shown once) → `MSTEAMS_APP_PASSWORD`

**2. Create an Azure Bot resource.** Portal → **Create a resource** → search **Azure Bot** → Create.

- Bot handle: any name
- Microsoft App ID: paste `MSTEAMS_APP_ID` from step 1 (select "Use existing app registration")
- Pricing: F0 (free) is fine for development

**3. Configure the messaging endpoint.** Your Bot resource → **Settings** → **Configuration**:

- **Messaging endpoint**: `<PUBLIC_URL>/webhook/msteams`
- Save

**4. Enable the Microsoft Teams channel.** Your Bot resource → **Channels** → click the Microsoft Teams icon → accept terms → Save.

**5. Build a Teams app manifest.** Teams won't surface the bot until there's a Teams app definition pointing at it. The fastest path is **Teams Developer Portal**:

- Visit [dev.teams.microsoft.com](https://dev.teams.microsoft.com)
- **Apps** → **New app** → fill in basics
- **App features** → **Bot** → **Select an existing bot** → choose the one from step 2
- **Personal**, **Team**, or **Group chat** scope as needed
- Publish to your org, or **Preview in Teams** → install in a test team

**6. Test.** In Teams, message your bot. The echo handler responds.

## Inbound shape

| Teams activity                | Msgly inbound                                          |
| ----------------------------- | ------------------------------------------------------ |
| `type: 'message'` (text)      | `content: { type: 'text', text }`                      |
| `type: 'message'` (file/image attachment) | `content: { type: 'image' \| 'file', mediaRef: { kind: 'url', value } }` |
| `type: 'message'` with `value` (card action) | `content: { type: 'text', text: value.text }` |
| `type: 'conversationUpdate'`, etc. | (skipped — no inbound message)                    |

Every inbound message carries metadata you'll likely need:

- `metadata.serviceUrl` — **required** for replies (Teams routes by region)
- `metadata.tenantId`
- `metadata.userId` (Bot Framework user id, e.g. `29:...`)
- `metadata.aadObjectId` (the user's Azure AD object id, if available)
- `metadata.conversationType` (`personal`, `groupChat`, `channel`)

## Reply path

The Bot Framework Connector lives at a **regional** `serviceUrl` like `https://smba.trafficmanager.net/amer/`. Each inbound activity tells you where to reply. To send, pass that URL back through metadata:

```typescript
await hub.send({
  channel: 'msteams',
  account: msg.account,
  contact: msg.contact,
  content: { type: 'text', text: 'reply' },
  metadata: { serviceUrl: msg.metadata?.serviceUrl },
});
```

If `metadata.serviceUrl` is missing, `send()` fails fast with `msteams_missing_service_url`. For proactive (unsolicited) messages, persist the serviceUrl from a prior message and pass it in.

## Capabilities

| Feature       | Supported |
| ------------- | --------- |
| text          | ✓         |
| image         | ✓ (URL attachment) |
| file          | ✓ (URL attachment) |
| video         | —         |
| audio         | —         |
| location      | ✓ (as map link) |
| buttons       | ✓ (hero card with messageBack actions) |
| quick replies | —         |
| reactions     | —         |
| typing        | ✓         |
| templates     | —         |

Buttons are rendered as a Bot Framework hero card with `messageBack` actions. When the user clicks, Teams sends an activity whose `value.text` matches your button id — your `hub.on('message')` handler receives that as a text message.

## Sending examples

### Buttons

```typescript
await hub.send({
  channel: 'msteams',
  account: msg.account,
  contact: msg.contact,
  content: {
    type: 'interactive',
    text: 'Pick one:',
    buttons: [
      { id: 'yes', label: 'Yes' },
      { id: 'no',  label: 'No' },
    ],
  },
  metadata: { serviceUrl: msg.metadata?.serviceUrl },
});
```

### Image (public URL)

```typescript
await hub.send({
  channel: 'msteams',
  account, contact,
  content: {
    type: 'image',
    mediaRef: { kind: 'url', value: 'https://example.com/cat.png', mimeType: 'image/png' },
    caption: 'meow',
  },
  metadata: { serviceUrl: msg.metadata?.serviceUrl },
});
```

## Runtime requirements

JWT verification (RS256) uses WebCrypto, native in Node 18+, Bun, Deno, Cloudflare Workers, and modern browsers. OAuth2 token requests use `fetch`, also native everywhere.

## Production security notes

### Trust model on outbound `serviceUrl`

When you reply, the adapter POSTs (with your OAuth bearer token) to whatever `serviceUrl` came in on the inbound activity. The inbound JWT verifies that Microsoft signed the activity — so a forged activity with a custom serviceUrl is rejected. In normal operation this is safe.

For defense-in-depth, the Microsoft Bot Framework SDKs maintain a whitelist of known Microsoft hosts (`*.botframework.com`, `*.skype.com`, `*.botservice.com`, regional variants). msgly does **not** do this in v1 — we trust the signed activity. If you're shipping to extra-paranoid customers, the layer above msgly can validate `msg.metadata.serviceUrl` against an allow-list before passing it through to `hub.send`.

### JWT verification details

- Algorithm pinned to RS256 (rejects `alg: none` attacks).
- `iss` validated against `https://api.botframework.com` (override via `expectedIssuer` for emulator or government cloud).
- `aud` validated against your `appId`.
- `exp` and `nbf` checked with a 5-minute default clock skew (configurable via `clockSkewSec`).
- JWKS cached for 24h with one-shot rotation when a token references an unknown `kid`.

## Common pitfalls

- **"401 Unauthorized" on first inbound**: the JWKS is fetched once on the first request. Make sure your server can reach `login.botframework.com` outbound.
- **`msteams_missing_service_url` on send**: you forgot to pass `metadata.serviceUrl` through. Teams replies are routed by region — there is no single global send URL.
- **Bot never receives messages**: check the messaging endpoint URL in Azure Bot → Configuration. After saving, Azure pings the endpoint as a health check; failures appear in the portal's **Test in Web Chat** panel.
- **Client secret expired**: secrets default to 6-month expiry. Regenerate in Azure AD → Certificates & secrets and update `MSTEAMS_APP_PASSWORD`.
- **Bot installed in Teams but doesn't respond**: confirm the Microsoft Teams channel is enabled in your Azure Bot resource → Channels.

## Documentation

Full setup walkthrough and multi-channel usage: https://github.com/AyushJain070401/msgly

## License

MIT
