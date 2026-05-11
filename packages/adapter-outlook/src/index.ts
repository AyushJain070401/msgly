import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface OutlookConfig {
  /** OAuth client id from Entra ID → App registrations → your app. */
  clientId: string;
  /** OAuth client secret from Certificates & secrets on the same app. */
  clientSecret: string;
  /**
   * Tenant for the OAuth token endpoint. Use `'common'` for multi-tenant apps,
   * a specific GUID for single-tenant. Default: `'common'`.
   */
  tenantId?: string;
  /**
   * Refresh token for the agent's mailbox. Obtained via the OAuth 2.0 auth
   * code flow with scopes `Mail.Read Mail.Send offline_access` and
   * `prompt=consent`.
   */
  refreshToken: string;
  /** UPN of the agent's mailbox. Used as `account.channelAccountId`. */
  emailAddress: string;
  /**
   * Shared secret echoed back on every notification. Graph proves
   * authenticity by sending this exact value in `clientState` on each event.
   * Set the same value when calling `createSubscription`.
   */
  clientState: string;

  /** Override the OAuth token endpoint. */
  tokenUrl?: string;
  /** Override the Microsoft Graph base. Default: graph.microsoft.com/v1.0. */
  graphBase?: string;
}

export interface OutlookAdapter extends Adapter {
  readonly channel: 'outlook';
  /** One-time setup: create a Graph change-notification subscription on the inbox. */
  createSubscription(opts: {
    notificationUrl: string;
    expirationMinutes?: number;
    lifecycleNotificationUrl?: string;
  }): Promise<{ id: string; expirationDateTime: string }>;
  /** Renew before expiry. Graph caps message subscriptions at 4230 minutes. */
  renewSubscription(
    subscriptionId: string,
    expirationMinutes?: number,
  ): Promise<{ expirationDateTime: string }>;
  /** Delete a subscription. */
  deleteSubscription(subscriptionId: string): Promise<void>;
}

const DEFAULT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TENANT = 'common';
const DEFAULT_TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const DEFAULT_SCOPE = 'Mail.Read Mail.Send offline_access';
const DEFAULT_EXPIRATION_MIN = 4230; // Graph's maximum for /messages

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------- OAuth token cache ----------

function createTokenCache(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
  scope: string,
) {
  let accessToken: string | null = null;
  let currentRefreshToken = refreshToken;
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'refresh_token',
        client_id: clientId,
        client_secret: clientSecret,
        refresh_token: currentRefreshToken,
        scope,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new Error(
        `Microsoft token refresh failed (${res.status}): ${
          data.error_description ?? data.error ?? 'no body'
        }`,
      );
    }
    accessToken = data.access_token;
    if (data.refresh_token) currentRefreshToken = data.refresh_token;
    expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    return accessToken;
  }

  async function get(): Promise<string> {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    if (inflight) return inflight;
    inflight = fetchToken();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  return { get };
}

// ---------- Graph notification & Message shapes ----------

interface GraphNotificationBody {
  value?: Array<{
    subscriptionId?: string;
    clientState?: string;
    changeType?: string;
    resource?: string;
    resourceData?: { id?: string; '@odata.type'?: string };
  }>;
  validationTokens?: string[];
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  body?: { contentType?: 'text' | 'html'; content?: string };
}

function stripHtml(html: string): string {
  return html
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractMessageText(msg: GraphMessage): string | null {
  if (!msg.body?.content) return msg.bodyPreview ?? null;
  if (msg.body.contentType === 'html') return stripHtml(msg.body.content);
  return msg.body.content.trim() || msg.bodyPreview || null;
}

/**
 * Outlook / Microsoft 365 mail adapter for Msgly.
 *
 * **Receive flow.** Microsoft Graph pushes change notifications to your
 * webhook when new messages arrive in the agent's inbox. Each notification
 * payload references a message id; the adapter fetches the full message
 * via Graph and emits an inbound message.
 *
 * **Validation handshake.** Graph verifies your endpoint at subscription
 * time by sending a POST with `?validationToken=xxx`. The adapter detects
 * this and echoes the token back as `text/plain` (returned via
 * `getInteractionAck`).
 *
 * **Authenticity.** Graph does NOT sign notifications. Instead, every
 * notification echoes the `clientState` you set when creating the
 * subscription. The adapter rejects any notification whose `clientState`
 * doesn't match the configured value — that's the entire signature check.
 *
 * **Reply path.** Inbound messages expose `metadata.messageId`. When you
 * pass it back through `hub.send`, the adapter calls `POST /me/messages/{id}/reply`
 * which preserves the conversation thread automatically. Without it, the
 * adapter falls back to `POST /me/sendMail` for unsolicited outbound.
 */
export function createOutlookAdapter(config: OutlookConfig): OutlookAdapter {
  const tenant = config.tenantId ?? DEFAULT_TENANT;
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL(tenant);
  const graphBase = config.graphBase ?? DEFAULT_GRAPH_BASE;

  const tokens = createTokenCache(
    tokenUrl,
    config.clientId,
    config.clientSecret,
    config.refreshToken,
    DEFAULT_SCOPE,
  );

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await tokens.get();
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('content-type') && init.body) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${graphBase}${path}`, { ...init, headers });
  }

  async function createSubscription(opts: {
    notificationUrl: string;
    expirationMinutes?: number;
    lifecycleNotificationUrl?: string;
  }): Promise<{ id: string; expirationDateTime: string }> {
    const minutes = opts.expirationMinutes ?? DEFAULT_EXPIRATION_MIN;
    const body: Record<string, unknown> = {
      changeType: 'created',
      notificationUrl: opts.notificationUrl,
      resource: "me/mailFolders('inbox')/messages",
      expirationDateTime: new Date(Date.now() + minutes * 60 * 1000).toISOString(),
      clientState: config.clientState,
    };
    if (opts.lifecycleNotificationUrl) {
      body['lifecycleNotificationUrl'] = opts.lifecycleNotificationUrl;
    }

    const res = await authedFetch('/subscriptions', {
      method: 'POST',
      body: JSON.stringify(body),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      expirationDateTime?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.id || !data.expirationDateTime) {
      throw new Error(
        `Graph createSubscription failed (${res.status}): ${data.error?.message ?? 'no id'}`,
      );
    }
    return { id: data.id, expirationDateTime: data.expirationDateTime };
  }

  async function renewSubscription(
    subscriptionId: string,
    expirationMinutes: number = DEFAULT_EXPIRATION_MIN,
  ): Promise<{ expirationDateTime: string }> {
    const res = await authedFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'PATCH',
      body: JSON.stringify({
        expirationDateTime: new Date(
          Date.now() + expirationMinutes * 60 * 1000,
        ).toISOString(),
      }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      expirationDateTime?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.expirationDateTime) {
      throw new Error(
        `Graph renewSubscription failed (${res.status}): ${data.error?.message ?? 'no expiry'}`,
      );
    }
    return { expirationDateTime: data.expirationDateTime };
  }

  async function deleteSubscription(subscriptionId: string): Promise<void> {
    const res = await authedFetch(`/subscriptions/${encodeURIComponent(subscriptionId)}`, {
      method: 'DELETE',
    });
    if (!res.ok && res.status !== 404) {
      throw new Error(`Graph deleteSubscription failed: ${res.status}`);
    }
  }

  async function fetchMessage(messageId: string): Promise<GraphMessage | null> {
    const res = await authedFetch(`/me/messages/${encodeURIComponent(messageId)}`);
    if (!res.ok) return null;
    return (await res.json()) as GraphMessage;
  }

  function messageToInbound(msg: GraphMessage): InboundMessage | null {
    const text = extractMessageText(msg);
    if (!text) return null;

    const from = msg.from?.emailAddress;
    if (!from?.address) return null;

    return {
      id: randomId(),
      externalId: msg.id,
      channel: 'outlook',
      direction: 'inbound',
      account: { channel: 'outlook', channelAccountId: config.emailAddress },
      contact: {
        channel: 'outlook',
        channelUserId: from.address,
        ...(from.name ? { displayName: from.name } : {}),
      },
      content: { type: 'text', text },
      timestamp: msg.receivedDateTime ?? new Date().toISOString(),
      raw: msg,
      metadata: {
        messageId: msg.id,
        ...(msg.conversationId ? { conversationId: msg.conversationId } : {}),
        ...(msg.internetMessageId ? { internetMessageId: msg.internetMessageId } : {}),
        ...(msg.subject ? { subject: msg.subject } : {}),
      },
    };
  }

  function getInteractionAck(
    req: WebhookRequest,
  ): { body: string; contentType?: string } | null {
    // Graph subscription-creation handshake: ?validationToken=xxx → echo as text/plain.
    const vt = req.query['validationToken'];
    const token = Array.isArray(vt) ? vt[0] : vt;
    if (typeof token === 'string' && token.length > 0) {
      return { body: token, contentType: 'text/plain' };
    }
    return null;
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    // The validation handshake POST is short-circuited by `getInteractionAck`
    // — the hub responds before we get here. So at this point we expect real
    // change notifications.
    const body = req.body as GraphNotificationBody | null;
    if (!body?.value?.length) return [];

    const out: InboundMessage[] = [];
    for (const entry of body.value) {
      const messageId = entry.resourceData?.id;
      if (!messageId) continue;
      const msg = await fetchMessage(messageId);
      if (!msg) continue;
      const inbound = messageToInbound(msg);
      if (inbound) out.push(inbound);
    }
    return out;
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // Validation handshake: short-circuit true (getInteractionAck handles the
    // response body). No body to verify.
    const vt = req.query['validationToken'];
    if (vt) return true;

    const body = req.body as GraphNotificationBody | null;
    if (!body?.value?.length) return false;
    for (const entry of body.value) {
      if (entry.clientState !== config.clientState) return false;
    }
    return true;
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'outlook_unsupported_content',
          message: `Outlook adapter only supports text content in v1 (received: ${message.content.type})`,
        },
      };
    }

    const replyTo = message.metadata?.['messageId'] as string | undefined;

    let res: Response;
    if (replyTo) {
      // Threaded reply — Graph adds proper In-Reply-To/References headers on
      // its own and keeps the conversation linked.
      res = await authedFetch(
        `/me/messages/${encodeURIComponent(replyTo)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({ comment: message.content.text }),
        },
      );
    } else {
      const subjectMeta = message.metadata?.['subject'] as string | undefined;
      const subject = subjectMeta ?? '(no subject)';
      res = await authedFetch('/me/sendMail', {
        method: 'POST',
        body: JSON.stringify({
          message: {
            subject,
            body: { contentType: 'Text', content: message.content.text },
            toRecipients: [
              { emailAddress: { address: message.contact.channelUserId } },
            ],
          },
          saveToSentItems: true,
        }),
      });
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        messageId: message.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }
    const data = (await res.json().catch(() => ({}))) as {
      error?: { code?: string; message?: string };
    };
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `outlook_${data.error?.code ?? res.status}`,
        message: data.error?.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.clientId || !config.clientSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'OutlookConfig.clientId / clientSecret missing. Generate in Entra ID → App registrations → your app → Certificates & secrets.',
      };
    }
    if (!config.refreshToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'OutlookConfig.refreshToken missing. Run the OAuth auth-code flow with scopes "Mail.Read Mail.Send offline_access" and prompt=consent.',
      };
    }
    if (!config.emailAddress) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'OutlookConfig.emailAddress missing. Set this to the UPN of the mailbox the refresh token belongs to.',
      };
    }
    if (!config.clientState) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'OutlookConfig.clientState missing. Pick any random string — it must match the value you pass to createSubscription.',
      };
    }
    try {
      const token = await tokens.get();
      const res = await fetch(`${graphBase}/me`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Graph rejected the access token. Re-check scopes (Mail.Read, Mail.Send, offline_access) and admin consent if required.',
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Graph /me returned ${res.status}`,
        };
      }
      const data = (await res.json()) as {
        userPrincipalName?: string;
        displayName?: string;
      };
      return {
        ok: true,
        accountInfo:
          data.userPrincipalName ?? data.displayName ?? config.emailAddress,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|invalid_grant|invalid_client/i.test(msg)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Microsoft rejected credentials: ${msg}. Re-check clientId/clientSecret/refreshToken.`,
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error('Outlook uploadMedia is not yet implemented in v1.');
  }
  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Outlook downloadMedia is not yet implemented in v1.');
  }

  return {
    channel: 'outlook',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    getInteractionAck,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    createSubscription,
    renewSubscription,
    deleteSubscription,
  };
}
