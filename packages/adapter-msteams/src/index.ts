import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface MsTeamsConfig {
  /** Microsoft App ID (GUID) from Azure Bot resource → Configuration. */
  appId: string;
  /** Client secret for the App ID. Generated under Azure AD → App registrations → Certificates & secrets. */
  appPassword: string;
  /**
   * Override the JWKS URL used to verify inbound JWT signatures.
   * Defaults to the public Bot Framework JWKS.
   */
  jwksUrl?: string;
  /**
   * Override the OAuth2 token endpoint used to obtain outbound access tokens.
   * Defaults to the multi-tenant Bot Framework endpoint.
   */
  tokenUrl?: string;
  /**
   * OAuth2 scope requested for outbound tokens.
   * Defaults to `https://api.botframework.com/.default`.
   */
  tokenScope?: string;
  /**
   * Expected `iss` claim on inbound JWTs.
   * Defaults to `https://api.botframework.com`.
   */
  expectedIssuer?: string;
  /**
   * How long (in ms) to cache the JWKS response before refetching.
   * Defaults to 24 hours.
   */
  jwksTtlMs?: number;
  /**
   * Allowed clock skew (in seconds) when validating `exp` / `nbf`.
   * Defaults to 300 (5 minutes).
   */
  clockSkewSec?: number;
}

export interface MsTeamsAdapter extends Adapter {
  readonly channel: 'msteams';
}

/**
 * Markdown formatting helpers for Microsoft Teams.
 * Pass `format: 'markdown'` on TextContent to activate rendering.
 *
 * @example
 * content: { type: 'text', format: 'markdown',
 *             text: `${fmt.bold('Hello')} ${fmt.italic('world')}` }
 */
export const fmt = {
  bold: (t: string) => `**${t}**`,
  italic: (t: string) => `_${t}_`,
  strikethrough: (t: string) => `~~${t}~~`,
  code: (t: string) => `\`${t}\``,
  codeBlock: (t: string, lang = '') => `\`\`\`${lang}\n${t}\n\`\`\``,
  link: (t: string, url: string) => `[${t}](${url})`,
};

const DEFAULT_JWKS_URL = 'https://login.botframework.com/v1/.well-known/keys';
const DEFAULT_TOKEN_URL =
  'https://login.microsoftonline.com/botframework.com/oauth2/v2.0/token';
const DEFAULT_TOKEN_SCOPE = 'https://api.botframework.com/.default';
const DEFAULT_ISSUER = 'https://api.botframework.com';
const DEFAULT_JWKS_TTL_MS = 24 * 60 * 60 * 1000;
const DEFAULT_CLOCK_SKEW_SEC = 300;

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: true },
  interactive: { buttons: true, quickReplies: false },
  templates: false,
  reactions: false,
  typing: true,
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

// ---------- base64url ----------

function b64urlToBytes(input: string): Uint8Array {
  // Convert base64url → base64 then atob.
  const base64 = input.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64.padEnd(base64.length + ((4 - (base64.length % 4)) % 4), '=');
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function b64urlToString(input: string): string {
  return new TextDecoder().decode(b64urlToBytes(input));
}

// ---------- JWKS ----------

interface JsonWebKey {
  kid?: string;
  kty?: string;
  use?: string;
  alg?: string;
  n?: string;
  e?: string;
  [k: string]: unknown;
}

interface JwksResponse {
  keys: JsonWebKey[];
}

interface CachedJwks {
  keys: Map<string, CryptoKey>;
  fetchedAt: number;
}

function createJwksCache(jwksUrl: string, ttlMs: number) {
  let cache: CachedJwks | null = null;
  let inflight: Promise<CachedJwks> | null = null;

  async function load(force = false): Promise<CachedJwks> {
    const now = Date.now();
    if (!force && cache && now - cache.fetchedAt < ttlMs) return cache;
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
          // Skip keys we can't import — JWKS may include non-RS256 entries.
        }
      }
      cache = { keys, fetchedAt: Date.now() };
      return cache;
    })();

    try {
      return await inflight;
    } finally {
      inflight = null;
    }
  }

  async function getKey(kid: string): Promise<CryptoKey | null> {
    let jwks = await load();
    let key = jwks.keys.get(kid);
    if (key) return key;
    // kid not in cache — JWKS might have rotated. Refetch once.
    jwks = await load(true);
    key = jwks.keys.get(kid);
    return key ?? null;
  }

  return { getKey };
}

// ---------- JWT verify ----------

interface JwtHeader {
  alg?: string;
  kid?: string;
  typ?: string;
}

interface JwtClaims {
  iss?: string;
  aud?: string | string[];
  exp?: number;
  nbf?: number;
  [k: string]: unknown;
}

async function verifyJwt(
  token: string,
  getKey: (kid: string) => Promise<CryptoKey | null>,
  expectedIssuer: string,
  expectedAudience: string,
  clockSkewSec: number,
): Promise<boolean> {
  const parts = token.split('.');
  if (parts.length !== 3) return false;
  const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

  let header: JwtHeader;
  let claims: JwtClaims;
  try {
    header = JSON.parse(b64urlToString(headerB64)) as JwtHeader;
    claims = JSON.parse(b64urlToString(payloadB64)) as JwtClaims;
  } catch {
    return false;
  }

  if (header.alg !== 'RS256' || !header.kid) return false;

  const key = await getKey(header.kid);
  if (!key) return false;

  let signature: Uint8Array;
  try {
    signature = b64urlToBytes(sigB64);
  } catch {
    return false;
  }

  const signedInput = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
  const sigOk = await globalThis.crypto.subtle.verify(
    'RSASSA-PKCS1-v1_5',
    key,
    signature as BufferSource,
    signedInput as BufferSource,
  );
  if (!sigOk) return false;

  const nowSec = Math.floor(Date.now() / 1000);
  if (typeof claims.exp === 'number' && nowSec > claims.exp + clockSkewSec) {
    return false;
  }
  if (typeof claims.nbf === 'number' && nowSec + clockSkewSec < claims.nbf) {
    return false;
  }
  if (claims.iss !== expectedIssuer) return false;

  const aud = Array.isArray(claims.aud) ? claims.aud : claims.aud ? [claims.aud] : [];
  if (!aud.includes(expectedAudience)) return false;

  return true;
}

// ---------- Outbound token cache ----------

function createTokenCache(
  tokenUrl: string,
  appId: string,
  appPassword: string,
  scope: string,
) {
  let token: string | null = null;
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;

  async function fetchToken(): Promise<string> {
    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: appId,
        client_secret: appPassword,
        scope,
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
        `Bot Framework token request failed (${res.status}): ${
          data.error_description ?? data.error ?? 'no body'
        }`,
      );
    }
    token = data.access_token;
    // Refresh 60s before expiry to dodge clock skew.
    expiresAt = Date.now() + (data.expires_in ?? 3600) * 1000 - 60_000;
    return token;
  }

  async function get(): Promise<string> {
    if (token && Date.now() < expiresAt) return token;
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

// ---------- Activity ↔ MessageContent ----------

interface TeamsAttachment {
  contentType?: string;
  contentUrl?: string;
  name?: string;
  content?: unknown;
}

interface TeamsActivity {
  type?: string;
  id?: string;
  serviceUrl?: string;
  channelId?: string;
  timestamp?: string;
  from?: { id?: string; name?: string; aadObjectId?: string };
  recipient?: { id?: string; name?: string };
  conversation?: {
    id?: string;
    conversationType?: string;
    tenantId?: string;
    name?: string;
  };
  text?: string;
  attachments?: TeamsAttachment[];
  value?: unknown;
  channelData?: { tenant?: { id?: string } };
}

function toTeamsOutbound(content: MessageContent): Record<string, unknown> {
  switch (content.type) {
    case 'text':
      return {
        type: 'message',
        text: content.text,
        ...(content.format === 'markdown' || content.format === 'html'
          ? { textFormat: 'markdown' }
          : {}),
      };

    case 'image':
    case 'file': {
      const att: TeamsAttachment = {
        contentType:
          content.mediaRef.mimeType ??
          (content.type === 'image' ? 'image/*' : 'application/octet-stream'),
        contentUrl: content.mediaRef.value,
        name: content.caption,
      };
      return {
        type: 'message',
        ...(content.caption ? { text: content.caption } : {}),
        attachments: [att],
      };
    }

    case 'location':
      return {
        type: 'message',
        text: `${content.name ? content.name + '\n' : ''}https://maps.google.com/?q=${content.latitude},${content.longitude}`,
      };

    case 'interactive':
      return {
        type: 'message',
        text: content.text,
        attachments: [
          {
            contentType: 'application/vnd.microsoft.card.hero',
            content: {
              text: content.text,
              buttons: (Array.isArray(content.buttons[0])
                ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
                : (content.buttons as import('@msgly/core').InteractiveButton[])
              ).slice(0, 6).map((b) => ({
                type: 'messageBack',
                title: b.label.slice(0, 80),
                value: b.id,
                text: b.id,
                displayText: b.label.slice(0, 80),
              })),
            },
          },
        ],
      };

    default:
      throw new Error(`Unsupported content type for Microsoft Teams: ${content.type}`);
  }
}

function parseAttachment(att: TeamsAttachment): MessageContent | null {
  if (!att.contentUrl) return null;
  const ct = att.contentType ?? '';
  if (ct.startsWith('image/')) {
    return {
      type: 'image',
      mediaRef: { kind: 'url', value: att.contentUrl, mimeType: ct },
      ...(att.name ? { caption: att.name } : {}),
    };
  }
  return {
    type: 'file',
    mediaRef: { kind: 'url', value: att.contentUrl, mimeType: ct },
    ...(att.name ? { caption: att.name } : {}),
  };
}

/**
 * Microsoft Teams adapter via the Bot Framework Connector API.
 *
 * **Setup model.** Teams bots are Azure Bot resources. Register your bot in
 * the Azure portal (Bot Channels Registration or Azure Bot resource), enable
 * the Microsoft Teams channel, and configure the messaging endpoint to point
 * at `<PUBLIC_URL>/webhook/msteams`. The bot's Microsoft App ID and client
 * secret are required to authenticate outbound calls and verify inbound JWTs.
 *
 * **Inbound auth.** Every POST from the Bot Framework Connector includes an
 * `Authorization: Bearer <JWT>` header. The JWT is RS256-signed by Microsoft.
 * `verifySignature` fetches the Bot Framework JWKS, verifies the signature,
 * and validates `iss` and `aud` (must be your App ID). JWKS is cached for
 * 24h with one-shot rotation on unknown `kid`.
 *
 * **Outbound auth.** Replies require an OAuth2 client-credentials token from
 * `login.microsoftonline.com`. The adapter caches the token until ~1 min
 * before expiry and posts to `${serviceUrl}/v3/conversations/${conversationId}/activities`.
 *
 * **Reply path.** Inbound messages expose `metadata.serviceUrl` and
 * `metadata.tenantId`. To reply, pass `metadata.serviceUrl` back through to
 * `hub.send`; the adapter routes the call to the right regional endpoint.
 * Without `metadata.serviceUrl`, sends fail — Teams doesn't have a single
 * global send URL.
 *
 * **Runtime requirement.** RS256 JWT verification uses WebCrypto, which is
 * native in Node 18+, Bun, Deno, Cloudflare Workers, and modern browsers.
 */
export function createMsTeamsAdapter(config: MsTeamsConfig): MsTeamsAdapter {
  const jwksUrl = config.jwksUrl ?? DEFAULT_JWKS_URL;
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const tokenScope = config.tokenScope ?? DEFAULT_TOKEN_SCOPE;
  const expectedIssuer = config.expectedIssuer ?? DEFAULT_ISSUER;
  const jwksTtlMs = config.jwksTtlMs ?? DEFAULT_JWKS_TTL_MS;
  const clockSkewSec = config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;

  const jwks = createJwksCache(jwksUrl, jwksTtlMs);
  const tokens = createTokenCache(tokenUrl, config.appId, config.appPassword, tokenScope);

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const serviceUrl = message.metadata?.['serviceUrl'] as string | undefined;
    const conversationId = message.contact.channelUserId;

    if (!serviceUrl) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'msteams_missing_service_url',
          message:
            'Microsoft Teams send requires metadata.serviceUrl (provided on every inbound activity). Pass it through when calling hub.send.',
        },
      };
    }

    const base = serviceUrl.endsWith('/') ? serviceUrl.slice(0, -1) : serviceUrl;
    const url = `${base}/v3/conversations/${encodeURIComponent(conversationId)}/activities`;
    const payload = toTeamsOutbound(message.content);

    let accessToken: string;
    try {
      accessToken = await tokens.get();
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'msteams_token_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const res = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${accessToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify(payload),
    });

    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      error?: { code?: string; message?: string };
      message?: string;
    };

    if (res.status >= 200 && res.status < 300) {
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
        code: `msteams_${data.error?.code ?? res.status}`,
        message: data.error?.message ?? data.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const activity = req.body as TeamsActivity | null;
    if (!activity) return [];
    if (activity.type !== 'message') return [];
    if (!activity.conversation?.id) return [];

    let content: MessageContent | null = null;
    if (activity.text) {
      content = { type: 'text', text: activity.text };
    } else if (activity.attachments && activity.attachments.length > 0) {
      // Skip channel-data attachments like "html" — find the first file/image.
      for (const att of activity.attachments) {
        const parsed = parseAttachment(att);
        if (parsed) {
          content = parsed;
          break;
        }
      }
    }

    // Card-action invocations (button presses) arrive as activities with
    // `value` set; surface them as text so the echo handler can match.
    if (!content && activity.value && typeof activity.value === 'object') {
      const v = activity.value as Record<string, unknown>;
      const text = typeof v['text'] === 'string'
        ? (v['text'] as string)
        : typeof v['value'] === 'string'
          ? (v['value'] as string)
          : null;
      if (text) content = { type: 'text', text };
    }

    if (!content) return [];

    const tenantId =
      activity.conversation.tenantId ?? activity.channelData?.tenant?.id;

    return [
      {
        id: randomId(),
        externalId: activity.id,
        channel: 'msteams',
        direction: 'inbound',
        account: {
          channel: 'msteams',
          channelAccountId: activity.recipient?.id ?? config.appId,
        },
        contact: {
          channel: 'msteams',
          channelUserId: activity.conversation.id,
          ...(activity.from?.name ? { displayName: activity.from.name } : {}),
        },
        content,
        timestamp: activity.timestamp ?? new Date().toISOString(),
        raw: activity,
        metadata: {
          ...(activity.serviceUrl ? { serviceUrl: activity.serviceUrl } : {}),
          ...(tenantId ? { tenantId } : {}),
          ...(activity.from?.aadObjectId
            ? { aadObjectId: activity.from.aadObjectId }
            : {}),
          ...(activity.from?.id ? { userId: activity.from.id } : {}),
          ...(activity.conversation.conversationType
            ? { conversationType: activity.conversation.conversationType }
            : {}),
        },
      },
    ];
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const auth = headerValue(req.headers, 'authorization');
    if (!auth || !auth.toLowerCase().startsWith('bearer ')) return false;
    const token = auth.slice(7).trim();
    if (!token) return false;
    try {
      return await verifyJwt(
        token,
        (kid) => jwks.getKey(kid),
        expectedIssuer,
        config.appId,
        clockSkewSec,
      );
    } catch {
      return false;
    }
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.appId) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'MsTeamsConfig.appId is empty. Find it in Azure portal → your Bot resource → Configuration → Microsoft App ID.',
      };
    }
    if (!config.appPassword) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'MsTeamsConfig.appPassword is empty. Generate it in Azure AD → App registrations → your app → Certificates & secrets → New client secret. Copy immediately — it is shown once.',
      };
    }
    try {
      await tokens.get();
      return { ok: true, accountInfo: config.appId };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/401|invalid_client|unauthorized/i.test(msg)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Microsoft rejected the App ID / client secret pair. Re-check both in Azure AD → App registrations. If the secret expired, generate a new one.',
        };
      }
      return {
        ok: false,
        reason: 'unknown',
        hint: `Bot Framework token request failed: ${msg}`,
      };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Microsoft Teams uploadMedia is not yet implemented. Host the file on a public URL and pass it via mediaRef.',
    );
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'url') {
      throw new Error('Microsoft Teams downloadMedia requires a url ref');
    }
    const res = await fetch(ref.value);
    if (res.status >= 400) {
      throw new Error(`Teams media fetch failed: ${res.status}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    return {
      data,
      mimeType:
        ref.mimeType ?? res.headers.get('content-type') ?? 'application/octet-stream',
    };
  }

  return {
    channel: 'msteams',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    uploadMedia,
    downloadMedia,
    verifyCredentials,
  };
}
