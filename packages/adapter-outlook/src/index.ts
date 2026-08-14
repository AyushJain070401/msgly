import type {
  Adapter,
  AdapterCapabilities,
  Attachment,
  AttachmentsConfig,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  OutboundMessage,
  StateStore,
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

  /**
   * Key-value store for persisting adapter state (OAuth token cache) across
   * adapter recreations. Compatible with ioredis and node-redis — pass your
   * Redis client directly:
   *
   * ```ts
   * import Redis from 'ioredis';
   * const outlook = createOutlookAdapter({ ...cfg, stateStore: new Redis() });
   * ```
   *
   * When set, the adapter auto-restores the cached access token on first use
   * and auto-persists it after every refresh. Supersedes `cachedAccessToken`
   * for reads (writes still fire `onTokenRefresh` if set).
   */
  stateStore?: StateStore;
  /**
   * Optional prefix for keys written to `stateStore`.
   * Default: `"msgly:outlook:{emailAddress}"`.
   */
  stateKeyPrefix?: string;
  /**
   * Restore a previously-cached access token so the adapter skips the initial
   * token refresh. Pair with `onTokenRefresh` to persist updates. Ignored when
   * `stateStore` is provided.
   */
  cachedAccessToken?: { token: string; expiresAt: number };
  /**
   * Called after every successful OAuth token refresh. Fires regardless of
   * whether `stateStore` is set — useful for logging or side-effects beyond
   * persistence.
   */
  onTokenRefresh?: (state: {
    accessToken: string;
    refreshToken: string;
    expiresAt: number;
  }) => void | Promise<void>;

  /**
   * Opt in to attachment support. Off by default — leave it unset and this
   * adapter behaves exactly as it always has.
   *
   * Graph inlines attachments up to 3 MB; anything larger needs an upload
   * session, which this adapter does not implement yet and will reject with a
   * clear error rather than a Graph 413.
   *
   * ```ts
   * createOutlookAdapter({ ...cfg, attachments: { enabled: true } });
   * ```
   */
  attachments?: AttachmentsConfig;

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

/**
 * Length-leak resistant string equality. Used for shared-secret comparisons
 * so an attacker can't recover the secret a byte at a time via response
 * timing.
 */
function constantTimeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return diff === 0;
}

/**
 * HTML formatting helpers for Outlook. Pass `format: 'html'` on TextContent
 * to send as an HTML email body (Graph contentType: 'HTML').
 *
 * @example
 * content: { type: 'text', format: 'html',
 *             text: `${fmt.bold('Hello')} ${fmt.link('click here', 'https://example.com')}` }
 */
export const fmt = {
  bold: (t: string) => `<b>${t}</b>`,
  italic: (t: string) => `<i>${t}</i>`,
  underline: (t: string) => `<u>${t}</u>`,
  strikethrough: (t: string) => `<s>${t}</s>`,
  code: (t: string) => `<code>${t}</code>`,
  pre: (t: string) => `<pre>${t}</pre>`,
  link: (t: string, url: string) => `<a href="${url}">${t}</a>`,
  color: (t: string, hex: string) => `<span style="color:${hex}">${t}</span>`,
  br: () => '<br>',
};

const DEFAULT_GRAPH_BASE = 'https://graph.microsoft.com/v1.0';
const DEFAULT_TENANT = 'common';
const DEFAULT_TOKEN_URL = (tenant: string) =>
  `https://login.microsoftonline.com/${tenant}/oauth2/v2.0/token`;
const DEFAULT_SCOPE = 'Mail.Read Mail.Send offline_access';
const DEFAULT_EXPIRATION_MIN = 4230; // Graph's maximum for /messages

/** Graph inlines `fileAttachment` bytes only up to 3 MB. */
const GRAPH_INLINE_ATTACHMENT_LIMIT = 3 * 1024 * 1024;

/**
 * Capabilities depend on config: email can carry any file type, but only once
 * the developer opts in. Reporting `file: false` when they haven't is what
 * makes the hub reject attachment sends up front instead of silently dropping
 * the files.
 */
function buildCapabilities(attachments?: AttachmentsConfig): AdapterCapabilities {
  const on = attachments?.enabled === true;
  return {
    text: true,
    media: { image: on, video: on, audio: on, file: on },
    interactive: { buttons: false, quickReplies: false },
    templates: false,
    reactions: false,
    typing: false,
  };
}

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
  opts?: {
    cachedAccessToken?: { token: string; expiresAt: number };
    stateStore?: StateStore | null;
    stateKeyPrefix?: string;
    onTokenRefresh?: (state: {
      accessToken: string;
      refreshToken: string;
      expiresAt: number;
    }) => void | Promise<void>;
  },
) {
  let accessToken: string | null = opts?.cachedAccessToken?.token ?? null;
  let currentRefreshToken = refreshToken;
  let expiresAt = opts?.cachedAccessToken?.expiresAt ?? 0;
  let inflight: Promise<string> | null = null;
  let storeRestored = !opts?.stateStore;

  async function restoreFromStore(): Promise<void> {
    if (storeRestored) return;
    storeRestored = true;
    try {
      const raw = await opts!.stateStore!.get(`${opts!.stateKeyPrefix}:tokenState`);
      if (!raw) return;
      const state = JSON.parse(raw) as {
        accessToken?: string;
        refreshToken?: string;
        expiresAt?: number;
      };
      if (state.accessToken && typeof state.expiresAt === 'number' && Date.now() < state.expiresAt) {
        accessToken = state.accessToken;
        expiresAt = state.expiresAt;
      }
      if (state.refreshToken) currentRefreshToken = state.refreshToken;
    } catch {
      // store unavailable or corrupt — fall through to normal refresh
    }
  }

  async function persistToStore(): Promise<void> {
    if (!opts?.stateStore) return;
    try {
      await opts.stateStore.set(
        `${opts.stateKeyPrefix}:tokenState`,
        JSON.stringify({
          accessToken,
          refreshToken: currentRefreshToken,
          expiresAt,
        }),
      );
    } catch {
      // best-effort
    }
  }

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
    opts?.onTokenRefresh?.({
      accessToken,
      refreshToken: currentRefreshToken,
      expiresAt,
    });
    await persistToStore();
    return accessToken;
  }

  async function get(): Promise<string> {
    await restoreFromStore();
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

interface GraphAttachment {
  id?: string;
  name?: string;
  contentType?: string;
  size?: number;
  isInline?: boolean;
  contentId?: string;
  /** Present on fileAttachment; absent on itemAttachment/referenceAttachment. */
  contentBytes?: string;
  '@odata.type'?: string;
}

interface GraphMessage {
  id: string;
  conversationId?: string;
  internetMessageId?: string;
  subject?: string;
  bodyPreview?: string;
  receivedDateTime?: string;
  hasAttachments?: boolean;
  attachments?: GraphAttachment[];
  from?: { emailAddress?: { name?: string; address?: string } };
  toRecipients?: Array<{ emailAddress?: { name?: string; address?: string } }>;
  body?: { contentType?: 'text' | 'html'; content?: string };
}

// ---------- base64 ----------

function bytesToB64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
}

function b64ToBytes(input: string): Uint8Array {
  const binary = atob(input);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Marks a reference whose bytes travel inside the reference itself. Graph takes
 * attachment bytes inline in the sendMail payload, so there is nothing to
 * upload ahead of time for files under the 3 MB limit.
 */
const INLINE_PREFIX = 'inline:';

async function toBytes(
  data: Uint8Array | Blob | ReadableStream<Uint8Array>,
): Promise<Uint8Array> {
  if (data instanceof Uint8Array) return data;
  if (typeof Blob !== 'undefined' && data instanceof Blob) {
    return new Uint8Array(await data.arrayBuffer());
  }
  const reader = (data as ReadableStream<Uint8Array>).getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.length;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.length;
  }
  return out;
}

/** Map Graph's attachment shape into lazy `Attachment` references. */
function graphAttachmentsToAttachments(
  messageId: string,
  attachments: GraphAttachment[] | undefined,
): Attachment[] {
  const out: Attachment[] = [];
  for (const a of attachments ?? []) {
    if (!a.id) continue;
    const filename = a.name ?? 'attachment';
    const mimeType = a.contentType ?? 'application/octet-stream';
    out.push({
      mediaRef: {
        kind: 'platform-id',
        value: `${messageId}:${a.id}`,
        mimeType,
        filename,
      },
      filename,
      mimeType,
      ...(a.size !== undefined ? { size: a.size } : {}),
      ...(a.isInline ? { inline: true } : {}),
      ...(a.contentId ? { contentId: a.contentId } : {}),
    });
  }
  return out;
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
  const attachmentsEnabled = config.attachments?.enabled === true;
  const capabilities = buildCapabilities(config.attachments);

  const statePrefix = config.stateKeyPrefix ?? `msgly:outlook:${config.emailAddress}`;

  const tokens = createTokenCache(
    tokenUrl,
    config.clientId,
    config.clientSecret,
    config.refreshToken,
    DEFAULT_SCOPE,
    {
      cachedAccessToken: config.cachedAccessToken,
      stateStore: config.stateStore ?? null,
      stateKeyPrefix: statePrefix,
      onTokenRefresh: config.onTokenRefresh,
    },
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
    // Only pay for the expand when the developer opted in.
    const query = attachmentsEnabled ? '?$expand=attachments' : '';
    const res = await authedFetch(
      `/me/messages/${encodeURIComponent(messageId)}${query}`,
    );
    if (!res.ok) return null;
    return (await res.json()) as GraphMessage;
  }

  function messageToInbound(msg: GraphMessage): InboundMessage | null {
    const text = extractMessageText(msg);
    const attachments = attachmentsEnabled
      ? graphAttachmentsToAttachments(msg.id, msg.attachments)
      : [];
    // An attachment-only email is still a real message once attachments are on.
    if (!text && attachments.length === 0) return null;

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
      content: { type: 'text', text: text ?? '' },
      ...(attachments.length > 0 ? { attachments } : {}),
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
      if (typeof entry.clientState !== 'string') return false;
      if (!constantTimeEqual(entry.clientState, config.clientState)) return false;
    }
    return true;
  }

  function assertAttachmentsEnabled(operation: string): void {
    if (!attachmentsEnabled) {
      throw new Error(
        `Outlook ${operation} requires attachments to be enabled: ` +
          'createOutlookAdapter({ ...cfg, attachments: { enabled: true } })',
      );
    }
  }

  /** Fetch the bytes behind a reference, whichever of the three forms it takes. */
  async function resolveBytes(ref: MediaReference): Promise<Uint8Array> {
    if (ref.kind === 'url') {
      const res = await fetch(ref.value);
      if (!res.ok) {
        throw new Error(`Failed to fetch attachment from ${ref.value}: HTTP ${res.status}`);
      }
      return new Uint8Array(await res.arrayBuffer());
    }

    if (ref.value.startsWith(INLINE_PREFIX)) {
      return b64ToBytes(ref.value.slice(INLINE_PREFIX.length));
    }

    // "<messageId>:<attachmentId>" — Graph attachment ids are scoped to their
    // message, so both halves are required.
    const separator = ref.value.indexOf(':');
    if (separator === -1) {
      throw new Error(
        `Outlook attachment reference must be "<messageId>:<attachmentId>", got "${ref.value}"`,
      );
    }
    const messageId = ref.value.slice(0, separator);
    const attachmentId = ref.value.slice(separator + 1);

    const res = await authedFetch(
      `/me/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
    );
    const data = (await res.json().catch(() => ({}))) as GraphAttachment & {
      error?: { message?: string };
    };
    if (!res.ok || data.contentBytes === undefined) {
      throw new Error(
        `Outlook attachment download failed: ${data.error?.message ?? `HTTP ${res.status}`}`,
      );
    }
    return b64ToBytes(data.contentBytes);
  }

  /** Turn outbound attachments into Graph fileAttachment objects. */
  async function buildGraphAttachments(
    attachments: Attachment[],
  ): Promise<Record<string, unknown>[]> {
    if (attachments.length === 0) return [];
    assertAttachmentsEnabled('sending attachments');

    const allowed = config.attachments?.allowedMimeTypes;
    const maxSize = config.attachments?.maxSizeBytes ?? GRAPH_INLINE_ATTACHMENT_LIMIT;

    return Promise.all(
      attachments.map(async (a) => {
        if (allowed && !allowed.includes(a.mimeType)) {
          throw new Error(`Attachment type ${a.mimeType} is not in allowedMimeTypes`);
        }
        const bytes = await resolveBytes(a.mediaRef);
        if (bytes.length > maxSize) {
          throw new Error(
            `Attachment ${a.filename} is ${bytes.length} bytes, over the ${maxSize} byte limit. ` +
              'Microsoft Graph requires an upload session above 3 MB, which this adapter does not support yet.',
          );
        }
        return {
          '@odata.type': '#microsoft.graph.fileAttachment',
          name: a.filename,
          contentType: a.mimeType,
          contentBytes: bytesToB64(bytes),
          ...(a.inline ?? a.contentId ? { isInline: true } : {}),
          ...(a.contentId ? { contentId: a.contentId } : {}),
        };
      }),
    );
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

    let graphAttachments: Record<string, unknown>[];
    try {
      graphAttachments = await buildGraphAttachments(message.attachments ?? []);
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'outlook_attachment_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
    const hasAttachments = graphAttachments.length > 0;

    let res: Response;
    if (replyTo) {
      // Threaded reply — Graph adds proper In-Reply-To/References headers on
      // its own and keeps the conversation linked. Attachments ride in the
      // `message` sub-object; `comment` alone cannot carry them.
      res = await authedFetch(
        `/me/messages/${encodeURIComponent(replyTo)}/reply`,
        {
          method: 'POST',
          body: JSON.stringify({
            comment: message.content.text,
            ...(hasAttachments ? { message: { attachments: graphAttachments } } : {}),
          }),
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
            body: {
              contentType: message.content.format === 'html' ? 'HTML' : 'Text',
              content: message.content.text,
            },
            toRecipients: [
              { emailAddress: { address: message.contact.channelUserId } },
            ],
            ...(hasAttachments ? { attachments: graphAttachments } : {}),
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

  /**
   * Graph takes attachment bytes inline in the sendMail payload, so there is
   * no upload step — this carries the bytes in the reference for `send`.
   */
  async function uploadMedia(file: MediaFile): Promise<MediaReference> {
    assertAttachmentsEnabled('uploadMedia');
    const bytes = await toBytes(file.data);
    return {
      kind: 'platform-id',
      value: `${INLINE_PREFIX}${bytesToB64(bytes)}`,
      mimeType: file.mimeType,
      ...(file.filename ? { filename: file.filename } : {}),
    };
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    assertAttachmentsEnabled('downloadMedia');
    const bytes = await resolveBytes(ref);
    return {
      data: bytes,
      mimeType: ref.mimeType ?? 'application/octet-stream',
      ...(ref.filename ? { filename: ref.filename } : {}),
    };
  }

  return {
    channel: 'outlook',
    capabilities,
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
