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

export interface GmailConfig {
  /** OAuth client id from Google Cloud Console → Credentials → OAuth 2.0 Client ID. */
  clientId: string;
  /** OAuth client secret from the same place. */
  clientSecret: string;
  /**
   * Long-lived refresh token for the agent's mailbox. Generated once via the
   * OAuth 2.0 consent flow with `prompt=consent` and `access_type=offline`.
   * Required scopes: `https://www.googleapis.com/auth/gmail.modify` (read +
   * send + watch).
   */
  refreshToken: string;
  /**
   * The email address of the mailbox the refresh token belongs to.
   * Used as the `From:` header on outgoing replies and as
   * `account.channelAccountId`.
   */
  emailAddress: string;

  /**
   * How Pub/Sub push requests prove they came from Google. Pick ONE:
   *
   *   { kind: 'jwt', expectedAudience }
   *     — Verify the OIDC JWT in `Authorization: Bearer <token>`.
   *       expectedAudience should match the audience you configured on the
   *       Pub/Sub push subscription (often the webhook URL itself).
   *
   *   { kind: 'token', token }
   *     — Simpler: configure your push subscription with
   *       `?token=...` and we'll match it against `req.query.token`.
   *
   *   { kind: 'none' } — DEV ONLY. No verification.
   */
  pushAuth:
    | { kind: 'jwt'; expectedAudience: string; expectedServiceAccountEmail?: string }
    | { kind: 'token'; token: string }
    | { kind: 'none' };

  /** Cap how many messages we fetch per Pub/Sub notification. Default: 25. */
  maxMessagesPerNotification?: number;
  /** Override the Google OAuth token endpoint. Default: oauth2.googleapis.com. */
  tokenUrl?: string;
  /** Override the Gmail API base. Default: gmail.googleapis.com. */
  apiBase?: string;
  /** Override the JWKS URL used when `pushAuth.kind === 'jwt'`. Default: Google certs. */
  jwksUrl?: string;
  /** Allowed clock skew (sec) when validating JWT exp/nbf. Default: 300. */
  clockSkewSec?: number;
}

export interface GmailAdapter extends Adapter {
  readonly channel: 'gmail';
  /**
   * Call once at deploy time to subscribe the mailbox to a Pub/Sub topic.
   * The topic must already grant publish permission to
   * `gmail-api-push@system.gserviceaccount.com`. Returns the historyId
   * baseline.
   */
  watch(topicName: string, labelIds?: string[]): Promise<{ historyId: string }>;
  /** Stop the existing watch. Mailbox stops emitting notifications. */
  stopWatch(): Promise<void>;
}

const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const DEFAULT_API_BASE = 'https://gmail.googleapis.com';
const DEFAULT_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs';
const DEFAULT_CLOCK_SKEW_SEC = 300;
const DEFAULT_MAX_MESSAGES = 25;

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

function headerValue(
  headers: WebhookRequest['headers'],
  name: string,
): string | undefined {
  const v = headers[name] ?? headers[name.toLowerCase()];
  if (Array.isArray(v)) return v[0];
  return v;
}

// ---------- base64 / base64url ----------

function b64urlEncode(input: string | Uint8Array): string {
  const bytes =
    typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function b64urlDecodeToBytes(input: string): Uint8Array {
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64urlDecodeToString(input: string): string {
  return new TextDecoder().decode(b64urlDecodeToBytes(input));
}

// ---------- JWKS / JWT verify ----------

interface JwksResponse {
  keys: Array<Record<string, unknown> & { kid?: string; kty?: string }>;
}

interface JwksCacheEntry {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

function createJwksCache(jwksUrl: string, ttlMs: number) {
  let cache: JwksCacheEntry | null = null;
  let inflight: Promise<JwksCacheEntry> | null = null;

  async function load(force = false): Promise<JwksCacheEntry> {
    if (!force && cache && Date.now() - cache.fetchedAt < ttlMs) return cache;
    if (inflight) return inflight;
    inflight = (async () => {
      const res = await fetch(jwksUrl);
      if (!res.ok) throw new Error(`JWKS fetch failed: ${res.status}`);
      const data = (await res.json()) as JwksResponse;
      const keys = new Map<string, CryptoKey>();
      for (const jwk of data.keys ?? []) {
        if (!jwk.kid || jwk.kty !== 'RSA') continue;
        try {
          const key = await globalThis.crypto.subtle.importKey(
            'jwk',
            jwk as globalThis.JsonWebKey,
            { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
            false,
            ['verify'],
          );
          keys.set(jwk.kid, key);
        } catch {
          // skip unsupported keys
        }
      }
      const entry: JwksCacheEntry = { keys, fetchedAt: Date.now() };
      cache = entry;
      return entry;
    })();
    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  async function getKey(kid: string): Promise<CryptoKey | null> {
    let jwks = await load();
    if (jwks.keys.has(kid)) return jwks.keys.get(kid)!;
    jwks = await load(true);
    return jwks.keys.get(kid) ?? null;
  }

  return { getKey };
}

async function verifyGoogleJwt(
  token: string,
  getKey: (kid: string) => Promise<CryptoKey | null>,
  expectedAudience: string,
  expectedServiceAccountEmail: string | undefined,
  clockSkewSec: number,
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: { alg?: string; kid?: string };
  let claims: {
    iss?: string;
    aud?: string;
    exp?: number;
    nbf?: number;
    email?: string;
    email_verified?: boolean;
  };
  try {
    header = JSON.parse(b64urlDecodeToString(headerB64));
    claims = JSON.parse(b64urlDecodeToString(payloadB64));
  } catch {
    return false;
  }

  if (header.alg !== 'RS256' || !header.kid) return false;
  const key = await getKey(header.kid);
  if (!key) return false;

  const signature = b64urlDecodeToBytes(sigB64);
  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);

  const ok = await globalThis.crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    signedInput as BufferSource,
  );
  if (!ok) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && nowSec > claims.exp + clockSkewSec) return false;
  if (typeof claims.nbf === 'number' && nowSec + clockSkewSec < claims.nbf) return false;
  if (
    claims.iss !== 'https://accounts.google.com' &&
    claims.iss !== 'accounts.google.com'
  ) {
    return false;
  }
  if (claims.aud !== expectedAudience) return false;
  if (expectedServiceAccountEmail && claims.email !== expectedServiceAccountEmail) {
    return false;
  }
  return true;
}

// ---------- OAuth token cache ----------

function createTokenCache(
  tokenUrl: string,
  clientId: string,
  clientSecret: string,
  refreshToken: string,
) {
  let accessToken: string | null = null;
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
        refresh_token: refreshToken,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };
    if (!res.ok || !data.access_token) {
      throw new Error(
        `Google token refresh failed (${res.status}): ${
          data.error_description ?? data.error ?? 'no body'
        }`,
      );
    }
    accessToken = data.access_token;
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

// ---------- Email parsing helpers ----------

interface GmailPayload {
  mimeType?: string;
  headers?: Array<{ name: string; value: string }>;
  body?: { data?: string; size?: number; attachmentId?: string };
  parts?: GmailPayload[];
}

interface GmailMessage {
  id: string;
  threadId?: string;
  internalDate?: string;
  labelIds?: string[];
  snippet?: string;
  payload?: GmailPayload;
}

function findHeader(payload: GmailPayload | undefined, name: string): string | undefined {
  const lower = name.toLowerCase();
  for (const h of payload?.headers ?? []) {
    if (h.name.toLowerCase() === lower) return h.value;
  }
  return undefined;
}

function findBodyByMimeType(
  payload: GmailPayload | undefined,
  mimeType: string,
): string | null {
  if (!payload) return null;
  if (payload.mimeType === mimeType && payload.body?.data) {
    try {
      return b64urlDecodeToString(payload.body.data);
    } catch {
      return null;
    }
  }
  for (const part of payload.parts ?? []) {
    const t = findBodyByMimeType(part, mimeType);
    if (t !== null) return t;
  }
  return null;
}

/**
 * Walk the MIME tree preferring `text/plain` anywhere in the tree. If none
 * exists, fall back to `text/html` (tags stripped). Returns null if neither
 * is present.
 */
function extractPlainText(payload: GmailPayload | undefined): string | null {
  const plain = findBodyByMimeType(payload, 'text/plain');
  if (plain !== null) return plain.trim() || null;

  const html = findBodyByMimeType(payload, 'text/html');
  if (html === null) return null;
  return (
    html
      .replace(/<style[\s\S]*?<\/style>/gi, '')
      .replace(/<script[\s\S]*?<\/script>/gi, '')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || null
  );
}

/**
 * Parse a simple `From: "Display Name" <addr@example.com>` header.
 * Returns just the address portion if present, else the raw value.
 */
function parseEmailAddress(header: string | undefined): {
  address: string;
  displayName?: string;
} | null {
  if (!header) return null;
  const trimmed = header.trim();
  const angle = trimmed.match(/^(?:"?([^"<]+?)"?\s*)?<([^>]+)>$/);
  if (angle) {
    return {
      address: angle[2]!.trim(),
      displayName: angle[1]?.trim() || undefined,
    };
  }
  if (/^\S+@\S+$/.test(trimmed)) return { address: trimmed };
  return null;
}

// ---------- RFC 5322 email construction ----------

function buildReplyEmail(opts: {
  from: string;
  to: string;
  subject: string;
  body: string;
  inReplyTo?: string;
  references?: string;
}): string {
  const headers = [
    `From: ${opts.from}`,
    `To: ${opts.to}`,
    `Subject: ${opts.subject}`,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=utf-8',
    'Content-Transfer-Encoding: 8bit',
    `Date: ${new Date().toUTCString()}`,
  ];
  if (opts.inReplyTo) headers.push(`In-Reply-To: ${opts.inReplyTo}`);
  if (opts.references) headers.push(`References: ${opts.references}`);
  return `${headers.join('\r\n')}\r\n\r\n${opts.body}`;
}

/** Strip "Re: " (case-insensitive) prefixes — used so we add exactly one. */
function stripReplyPrefix(subject: string): string {
  return subject.replace(/^(?:re|RE|Re)\s*:\s*/i, '').trim();
}

// ---------- Adapter factory ----------

/**
 * Gmail adapter for Msgly — receives via Pub/Sub push notifications,
 * sends via the Gmail REST API.
 *
 * **Receive flow.** Gmail publishes change notifications to a Pub/Sub topic
 * (you set this up once via `users.watch`). Pub/Sub forwards each event to
 * your webhook with body `{ message: { data: base64, ... }, subscription }`.
 * `data` decodes to `{ emailAddress, historyId }`. The adapter calls
 * `history.list` from the previously-seen historyId to discover new message
 * IDs, fetches each via `messages.get?format=full`, and emits an inbound
 * message per item.
 *
 * **State.** The "last seen historyId" is held in adapter memory. On the
 * very first notification (cold start), the adapter falls back to fetching
 * recent unread INBOX messages so nothing gets lost between deploys.
 *
 * **Send flow.** Builds an RFC 5322 email with proper In-Reply-To /
 * References headers and posts to `users.messages.send`. If you pass
 * `metadata.threadId` from the inbound message, Gmail keeps the reply in
 * the original thread.
 *
 * **Auth.** Pub/Sub authenticates inbound webhooks via OIDC JWT
 * (Authorization: Bearer) or a shared verification token, configurable via
 * `pushAuth`. JWT verification uses Google's public JWKS and runs on pure
 * WebCrypto (Node 18+, Bun, Deno, browsers).
 */
export function createGmailAdapter(config: GmailConfig): GmailAdapter {
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const jwksUrl = config.jwksUrl ?? DEFAULT_JWKS_URL;
  const clockSkewSec = config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;
  const maxMessages = config.maxMessagesPerNotification ?? DEFAULT_MAX_MESSAGES;

  const tokens = createTokenCache(tokenUrl, config.clientId, config.clientSecret, config.refreshToken);
  const jwks = createJwksCache(jwksUrl, 24 * 60 * 60 * 1000);

  let lastHistoryId: string | null = null;

  async function authedFetch(path: string, init: RequestInit = {}): Promise<Response> {
    const token = await tokens.get();
    const headers = new Headers(init.headers as HeadersInit | undefined);
    headers.set('authorization', `Bearer ${token}`);
    if (!headers.has('content-type') && init.body) {
      headers.set('content-type', 'application/json');
    }
    return fetch(`${apiBase}${path}`, { ...init, headers });
  }

  async function watch(topicName: string, labelIds: string[] = ['INBOX']): Promise<{ historyId: string }> {
    const res = await authedFetch('/gmail/v1/users/me/watch', {
      method: 'POST',
      body: JSON.stringify({ topicName, labelIds, labelFilterAction: 'include' }),
    });
    const data = (await res.json().catch(() => ({}))) as {
      historyId?: string;
      error?: { message?: string };
    };
    if (!res.ok || !data.historyId) {
      throw new Error(`Gmail watch failed (${res.status}): ${data.error?.message ?? 'no historyId'}`);
    }
    lastHistoryId = data.historyId;
    return { historyId: data.historyId };
  }

  async function stopWatch(): Promise<void> {
    await authedFetch('/gmail/v1/users/me/stop', { method: 'POST' });
  }

  async function fetchMessage(messageId: string): Promise<GmailMessage | null> {
    const res = await authedFetch(
      `/gmail/v1/users/me/messages/${encodeURIComponent(messageId)}?format=full`,
    );
    if (!res.ok) return null;
    return (await res.json()) as GmailMessage;
  }

  async function listRecentInboxMessageIds(limit: number): Promise<string[]> {
    const res = await authedFetch(
      `/gmail/v1/users/me/messages?maxResults=${limit}&q=${encodeURIComponent('in:inbox -in:drafts is:unread')}`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as { messages?: Array<{ id: string }> };
    return (data.messages ?? []).map((m) => m.id);
  }

  async function listMessageIdsSince(startHistoryId: string): Promise<string[]> {
    const res = await authedFetch(
      `/gmail/v1/users/me/history?startHistoryId=${encodeURIComponent(startHistoryId)}&historyTypes=messageAdded&labelId=INBOX`,
    );
    if (!res.ok) return [];
    const data = (await res.json()) as {
      history?: Array<{
        id?: string;
        messagesAdded?: Array<{ message?: { id: string; labelIds?: string[] } }>;
      }>;
      historyId?: string;
    };
    const ids = new Set<string>();
    for (const entry of data.history ?? []) {
      for (const added of entry.messagesAdded ?? []) {
        if (added.message?.id) ids.add(added.message.id);
      }
    }
    return [...ids].slice(0, maxMessages);
  }

  function messageToInbound(msg: GmailMessage): InboundMessage | null {
    const text = extractPlainText(msg.payload);
    if (!text) return null;

    const from = parseEmailAddress(findHeader(msg.payload, 'From'));
    if (!from) return null;

    const messageIdHeader = findHeader(msg.payload, 'Message-ID') ?? findHeader(msg.payload, 'Message-Id');
    const subject = findHeader(msg.payload, 'Subject') ?? '';
    const references = findHeader(msg.payload, 'References');
    const dateHeader = findHeader(msg.payload, 'Date');

    const timestamp = (() => {
      if (msg.internalDate) {
        const ms = Number(msg.internalDate);
        if (Number.isFinite(ms)) return new Date(ms).toISOString();
      }
      if (dateHeader) {
        const parsed = Date.parse(dateHeader);
        if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
      }
      return new Date().toISOString();
    })();

    return {
      id: randomId(),
      externalId: msg.id,
      channel: 'gmail',
      direction: 'inbound',
      account: { channel: 'gmail', channelAccountId: config.emailAddress },
      contact: {
        channel: 'gmail',
        channelUserId: from.address,
        ...(from.displayName ? { displayName: from.displayName } : {}),
      },
      content: { type: 'text', text },
      timestamp,
      raw: msg,
      metadata: {
        ...(msg.threadId ? { threadId: msg.threadId } : {}),
        ...(messageIdHeader ? { messageId: messageIdHeader } : {}),
        ...(subject ? { subject } : {}),
        ...(references ? { references } : {}),
      },
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    // Pub/Sub push body: { message: { data: <base64>, ... }, subscription }
    const body = req.body as
      | { message?: { data?: string }; subscription?: string }
      | null;
    const dataB64 = body?.message?.data;
    if (!dataB64) return [];

    let notification: { emailAddress?: string; historyId?: string };
    try {
      notification = JSON.parse(b64urlDecodeToString(dataB64.replace(/=+$/g, '')));
    } catch {
      return [];
    }
    if (!notification.historyId) return [];

    let messageIds: string[];
    if (lastHistoryId) {
      messageIds = await listMessageIdsSince(lastHistoryId);
    } else {
      messageIds = await listRecentInboxMessageIds(maxMessages);
    }
    lastHistoryId = notification.historyId;

    const out: InboundMessage[] = [];
    for (const id of messageIds) {
      const msg = await fetchMessage(id);
      if (!msg) continue;
      const inbound = messageToInbound(msg);
      if (inbound) out.push(inbound);
    }
    return out;
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    switch (config.pushAuth.kind) {
      case 'none':
        return true;
      case 'token': {
        const provided = req.query['token'];
        const value = Array.isArray(provided) ? provided[0] : provided;
        return value === config.pushAuth.token;
      }
      case 'jwt': {
        const auth = headerValue(req.headers, 'authorization');
        if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;
        const token = auth.slice(7).trim();
        if (!token) return false;
        try {
          return await verifyGoogleJwt(
            token,
            (kid) => jwks.getKey(kid),
            config.pushAuth.expectedAudience,
            config.pushAuth.expectedServiceAccountEmail,
            clockSkewSec,
          );
        } catch {
          return false;
        }
      }
    }
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    if (message.content.type !== 'text') {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'gmail_unsupported_content',
          message: `Gmail adapter only supports text content in v1 (received: ${message.content.type})`,
        },
      };
    }

    const subjectMeta = message.metadata?.['subject'] as string | undefined;
    const baseSubject = subjectMeta ? stripReplyPrefix(subjectMeta) : '';
    const subject = baseSubject ? `Re: ${baseSubject}` : '(no subject)';

    const inReplyTo = message.metadata?.['messageId'] as string | undefined;
    const referencesPrev = message.metadata?.['references'] as string | undefined;
    const references = inReplyTo
      ? referencesPrev
        ? `${referencesPrev} ${inReplyTo}`
        : inReplyTo
      : undefined;

    const raw = buildReplyEmail({
      from: config.emailAddress,
      to: message.contact.channelUserId,
      subject,
      body: message.content.text,
      inReplyTo,
      references,
    });

    const payload: Record<string, unknown> = { raw: b64urlEncode(raw) };
    const threadId = message.metadata?.['threadId'] as string | undefined;
    if (threadId) payload['threadId'] = threadId;

    const res = await authedFetch('/gmail/v1/users/me/messages/send', {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { message?: string; code?: number };
    };

    if (res.status >= 200 && res.status < 300 && data.id) {
      return {
        messageId: message.id,
        externalId: data.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }
    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `gmail_${data.error?.code ?? res.status}`,
        message: data.error?.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.clientId || !config.clientSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GmailConfig.clientId / clientSecret missing. Generate them in Google Cloud Console → APIs & Services → Credentials → OAuth 2.0 Client ID.',
      };
    }
    if (!config.refreshToken) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GmailConfig.refreshToken missing. Run the consent flow once with prompt=consent and access_type=offline to obtain a long-lived refresh token.',
      };
    }
    if (!config.emailAddress) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GmailConfig.emailAddress missing. Set this to the mailbox the refresh token belongs to (e.g. agent@yourcompany.com).',
      };
    }
    try {
      const token = await tokens.get();
      const res = await fetch(`${apiBase}/gmail/v1/users/me/profile`, {
        headers: { authorization: `Bearer ${token}` },
      });
      if (res.status === 401 || res.status === 403) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Google rejected the access token. Check scopes (need gmail.modify) and re-run consent with prompt=consent.',
        };
      }
      if (!res.ok) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `Gmail profile lookup returned ${res.status}`,
        };
      }
      const data = (await res.json()) as { emailAddress?: string };
      return { ok: true, accountInfo: data.emailAddress ?? config.emailAddress };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|invalid_grant|invalid_client/i.test(msg)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Google rejected credentials: ${msg}. Re-check clientId/clientSecret/refreshToken.`,
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error('Gmail uploadMedia is not yet implemented in v1.');
  }
  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Gmail downloadMedia is not yet implemented in v1.');
  }

  return {
    channel: 'gmail',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    watch,
    stopWatch,
  };
}
