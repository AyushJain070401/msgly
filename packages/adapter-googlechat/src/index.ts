import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  InteractiveButton,
  MediaFile,
  MediaReference,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface GoogleChatConfig {
  /**
   * Service account email, e.g. `chat-bot@my-project.iam.gserviceaccount.com`.
   * From the JSON key file's `client_email`.
   */
  serviceAccountEmail: string;
  /**
   * Service account private key in PEM form — the JSON key file's
   * `private_key`, including the BEGIN/END lines. Escaped `\n` sequences are
   * handled, so a value read straight from an env var works.
   */
  privateKey: string;

  /**
   * Google Cloud **project number** (digits, not the project id). Inbound
   * requests carry a Google-signed JWT whose `aud` claim is this value, and
   * verification rejects anything else. Without it, inbound requests are not
   * authenticated.
   */
  projectNumber?: string;

  /** Default space to post into, e.g. `spaces/AAAA1234`. */
  defaultSpace?: string;

  /** Override the Chat API base. Default: `https://chat.googleapis.com`. */
  apiBase?: string;
  /** Override the OAuth token endpoint. Default: Google's. */
  tokenUrl?: string;
  /** Override the JWKS URL used to verify inbound tokens. */
  jwksUrl?: string;
  /** Allowed clock skew in seconds when validating JWT exp/nbf. Default: 300. */
  clockSkewSec?: number;
}

export interface GoogleChatAdapter extends Adapter {
  readonly channel: 'googlechat';
  /** Fetch (and cache) an OAuth access token for the Chat API. */
  getAccessToken(): Promise<string>;
}

const DEFAULT_API_BASE = 'https://chat.googleapis.com';
const DEFAULT_TOKEN_URL = 'https://oauth2.googleapis.com/token';
/** Google publishes the Chat webhook signing keys under this service account. */
const DEFAULT_JWKS_URL =
  'https://www.googleapis.com/service_accounts/v1/jwk/chat@system.gserviceaccount.com';
const CHAT_SCOPE = 'https://www.googleapis.com/auth/chat.bot';
const DEFAULT_CLOCK_SKEW_SEC = 300;

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  // Chat bots post card links rather than uploading media through this API.
  media: { image: false, video: false, audio: false, file: false },
  interactive: { buttons: true, quickReplies: false },
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

function flattenButtons(
  buttons: InteractiveButton[] | InteractiveButton[][],
): InteractiveButton[] {
  return Array.isArray(buttons[0])
    ? (buttons as InteractiveButton[][]).flat()
    : (buttons as InteractiveButton[]);
}

function b64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
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

/**
 * Strip the PEM armour and decode to DER.
 *
 * Also converts literal `\n` sequences to real newlines, because a private key
 * pasted into an env var almost always arrives escaped.
 */
export function pemToDer(pem: string): Uint8Array {
  const normalized = pem.replace(/\\n/g, '\n');
  const body = normalized
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Sign a service-account JWT assertion (RS256) and exchange it for an OAuth
 * access token. This is the standard two-legged flow — no user consent, no
 * refresh token.
 */
export async function createServiceAccountJwt(opts: {
  email: string;
  privateKeyPem: string;
  scope: string;
  audience: string;
  nowSec?: number;
}): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const header = { alg: 'RS256', typ: 'JWT' };
  const claims = {
    iss: opts.email,
    scope: opts.scope,
    aud: opts.audience,
    iat: now,
    exp: now + 3600,
  };

  const signingInput = `${b64urlEncode(JSON.stringify(header))}.${b64urlEncode(
    JSON.stringify(claims),
  )}`;

  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pemToDer(opts.privateKeyPem) as BufferSource,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(signingInput),
  );

  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

interface JwksKey {
  kid?: string;
  kty?: string;
  n?: string;
  e?: string;
  alg?: string;
  use?: string;
}

function createJwksCache(url: string, ttlMs: number) {
  let keys: JwksKey[] = [];
  let fetchedAt = 0;

  async function get(kid: string): Promise<CryptoKey | null> {
    if (Date.now() - fetchedAt > ttlMs || keys.length === 0) {
      const res = await fetch(url);
      if (!res.ok) return null;
      const data = (await res.json().catch(() => ({}))) as { keys?: JwksKey[] };
      keys = data.keys ?? [];
      fetchedAt = Date.now();
    }

    const jwk = keys.find((k) => k.kid === kid);
    if (!jwk?.n || !jwk.e) return null;

    try {
      return await globalThis.crypto.subtle.importKey(
        'jwk',
        { kty: 'RSA', n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
        { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
        false,
        ['verify'],
      );
    } catch {
      return null;
    }
  }

  return { get };
}

interface ChatUser {
  name?: string;
  displayName?: string;
  email?: string;
  type?: string;
}

interface ChatEvent {
  type?: string;
  eventTime?: string;
  space?: { name?: string; displayName?: string; type?: string };
  user?: ChatUser;
  message?: {
    name?: string;
    text?: string;
    argumentText?: string;
    thread?: { name?: string };
    sender?: ChatUser;
    createTime?: string;
  };
  // Present on CARD_CLICKED events.
  action?: { actionMethodName?: string; parameters?: Array<{ key?: string; value?: string }> };
  common?: { invokedFunction?: string; parameters?: Record<string, string> };
}

/**
 * Google Chat adapter for Msgly.
 *
 * **Auth.** Two-legged service account flow: sign an RS256 JWT assertion with
 * the service account key, exchange it for an OAuth access token, cache it.
 *
 * **Send.** `POST /v1/{space}/messages`.
 *
 * **Receive.** Google sends events with a bearer JWT in the `Authorization`
 * header, signed by `chat@system.gserviceaccount.com`. Set `projectNumber` and
 * the adapter verifies the signature, `iss`, `aud`, and expiry.
 */
export function createGoogleChatAdapter(config: GoogleChatConfig): GoogleChatAdapter {
  const apiBase = config.apiBase ?? DEFAULT_API_BASE;
  const tokenUrl = config.tokenUrl ?? DEFAULT_TOKEN_URL;
  const jwks = createJwksCache(config.jwksUrl ?? DEFAULT_JWKS_URL, 24 * 60 * 60 * 1000);
  const clockSkewSec = config.clockSkewSec ?? DEFAULT_CLOCK_SKEW_SEC;

  let accessToken: string | null = null;
  let expiresAt = 0;
  let inflight: Promise<string> | null = null;

  async function fetchAccessToken(): Promise<string> {
    const assertion = await createServiceAccountJwt({
      email: config.serviceAccountEmail,
      privateKeyPem: config.privateKey,
      scope: CHAT_SCOPE,
      audience: tokenUrl,
    });

    const res = await fetch(tokenUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
        assertion,
      }).toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      access_token?: string;
      expires_in?: number;
      error?: string;
      error_description?: string;
    };

    if (!data.access_token) {
      throw new Error(
        `Google Chat token exchange failed: ${data.error_description ?? data.error ?? `HTTP ${res.status}`}`,
      );
    }

    accessToken = data.access_token;
    // Refresh a minute early so an in-flight request never uses a dead token.
    expiresAt = Date.now() + ((data.expires_in ?? 3600) - 60) * 1000;
    return accessToken;
  }

  async function getAccessToken(): Promise<string> {
    if (accessToken && Date.now() < expiresAt) return accessToken;
    // Collapse concurrent refreshes into one request.
    inflight ??= fetchAccessToken().finally(() => {
      inflight = null;
    });
    return inflight;
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    // No project number → nothing to check `aud` against, so we cannot
    // meaningfully verify. Documented as insecure.
    if (!config.projectNumber) return true;

    const rawAuth = req.headers?.['authorization'] ?? req.headers?.['Authorization'];
    const header = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;
    if (typeof header !== 'string') return false;

    const token = header.replace(/^Bearer\s+/i, '');
    const parts = token.split('.');
    if (parts.length !== 3) return false;

    const [headerB64, payloadB64, sigB64] = parts as [string, string, string];

    let jwtHeader: { alg?: string; kid?: string };
    let claims: { iss?: string; aud?: string; exp?: number; nbf?: number };
    try {
      jwtHeader = JSON.parse(b64urlDecodeToString(headerB64));
      claims = JSON.parse(b64urlDecodeToString(payloadB64));
    } catch {
      return false;
    }

    // Pin the algorithm — accepting `alg` from the token invites confusion
    // attacks (`none`, or HS256 keyed with the public key).
    if (jwtHeader.alg !== 'RS256' || !jwtHeader.kid) return false;

    const key = await jwks.get(jwtHeader.kid);
    if (!key) return false;

    const ok = await globalThis.crypto.subtle.verify(
      'RSASSA-PKCS1-v1_5',
      key,
      b64urlDecodeToBytes(sigB64) as BufferSource,
      new TextEncoder().encode(`${headerB64}.${payloadB64}`),
    );
    if (!ok) return false;

    const nowSec = Math.floor(Date.now() / 1000);
    if (typeof claims.exp === 'number' && nowSec > claims.exp + clockSkewSec) return false;
    if (typeof claims.nbf === 'number' && nowSec + clockSkewSec < claims.nbf) return false;
    if (claims.iss !== 'chat@system.gserviceaccount.com') return false;
    if (claims.aud !== config.projectNumber) return false;

    return true;
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const event = req.body as ChatEvent | null;
    if (!event) return [];

    const spaceName = event.space?.name;
    if (!spaceName) return [];

    // ADDED_TO_SPACE / REMOVED_FROM_SPACE are lifecycle events, not messages.
    if (event.type !== 'MESSAGE' && event.type !== 'CARD_CLICKED') return [];

    const sender = event.message?.sender ?? event.user;
    const senderId = sender?.name;
    if (!senderId) return [];
    // Ignore anything the bot itself posted, which would otherwise loop.
    if (sender?.type === 'BOT') return [];

    const timestamp =
      event.eventTime ?? event.message?.createTime ?? new Date().toISOString();

    const metadata: Record<string, unknown> = {
      spaceName,
      userId: senderId,
      ...(event.message?.thread?.name ? { threadName: event.message.thread.name } : {}),
      ...(event.message?.name ? { messageName: event.message.name } : {}),
      ...(sender.email ? { userEmail: sender.email } : {}),
    };

    if (event.type === 'CARD_CLICKED') {
      // Button clicks arrive as their own event type; surface the payload the
      // same way other adapters surface postbacks.
      const action =
        event.common?.invokedFunction ?? event.action?.actionMethodName ?? '';
      return [
        {
          id: randomId(),
          ...(event.message?.name ? { externalId: event.message.name } : {}),
          channel: 'googlechat',
          direction: 'inbound',
          account: { channel: 'googlechat', channelAccountId: spaceName },
          contact: {
            channel: 'googlechat',
            channelUserId: spaceName,
            ...(sender.displayName ? { displayName: sender.displayName } : {}),
          },
          content: { type: 'text', text: action },
          interaction: { id: senderId, data: action },
          timestamp,
          raw: event,
          metadata,
        },
      ];
    }

    // `argumentText` strips the @mention; `text` keeps it.
    const text = event.message?.argumentText?.trim() || event.message?.text || '';
    if (!text) return [];

    return [
      {
        id: randomId(),
        ...(event.message?.name ? { externalId: event.message.name } : {}),
        channel: 'googlechat',
        direction: 'inbound',
        account: { channel: 'googlechat', channelAccountId: spaceName },
        contact: {
          channel: 'googlechat',
          // The space is the conversation, so replies address the space.
          channelUserId: spaceName,
          ...(sender.displayName ? { displayName: sender.displayName } : {}),
        },
        content: { type: 'text', text },
        timestamp,
        raw: event,
        metadata,
      },
    ];
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const content = message.content;
    const space =
      message.contact.channelUserId ||
      (message.metadata?.['spaceName'] as string | undefined) ||
      config.defaultSpace;

    if (!space) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'googlechat_missing_space',
          message:
            'No space to post to. Set contact.channelUserId to a space name like "spaces/AAAA", or configure defaultSpace.',
        },
      };
    }

    let payload: Record<string, unknown>;
    switch (content.type) {
      case 'text':
        payload = { text: content.text };
        break;

      case 'location':
        payload = {
          text: `${content.name ? `${content.name}\n` : ''}https://maps.google.com/?q=${content.latitude},${content.longitude}`,
        };
        break;

      case 'interactive': {
        const flat = flattenButtons(content.buttons);
        payload = {
          text: content.text,
          cardsV2: [
            {
              cardId: randomId(),
              card: {
                sections: [
                  {
                    widgets: [
                      {
                        buttonList: {
                          buttons: flat.map((b) => ({
                            text: b.label,
                            onClick: {
                              action: {
                                function: b.id,
                                parameters: [{ key: 'action', value: b.id }],
                              },
                            },
                          })),
                        },
                      },
                    ],
                  },
                ],
              },
            },
          ],
        };
        break;
      }

      default:
        return {
          messageId: message.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: {
            code: 'googlechat_unsupported_content',
            message:
              `Google Chat supports text, location and interactive content (received: ${content.type}). ` +
              'Bots share files by linking them rather than uploading.',
          },
        };
    }

    // Reply in the same thread when we know it.
    const threadName = message.metadata?.['threadName'] as string | undefined;
    if (threadName) payload['thread'] = { name: threadName };

    let token: string;
    try {
      token = await getAccessToken();
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'googlechat_auth_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const url = new URL(`${apiBase}/v1/${space}/messages`);
    if (threadName) {
      // Without this, a threaded reply silently starts a new thread.
      url.searchParams.set('messageReplyOption', 'REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    }

    let res: Response;
    try {
      res = await fetch(url.toString(), {
        method: 'POST',
        headers: {
          authorization: `Bearer ${token}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify(payload),
      });
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'googlechat_network_error',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }

    const data = (await res.json().catch(() => ({}))) as {
      name?: string;
      error?: { code?: number; message?: string; status?: string };
    };

    if (res.ok && data.name) {
      return {
        messageId: message.id,
        externalId: data.name,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    }

    return {
      messageId: message.id,
      status: 'failed',
      timestamp: new Date().toISOString(),
      error: {
        code: `googlechat_${data.error?.status ?? data.error?.code ?? res.status}`,
        message: data.error?.message ?? `HTTP ${res.status}`,
      },
    };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.serviceAccountEmail || !config.privateKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'GoogleChatConfig.serviceAccountEmail and privateKey are required — take client_email and private_key from the service account JSON key file.',
      };
    }

    try {
      await getAccessToken();
      return {
        ok: true,
        accountInfo: `${config.serviceAccountEmail}${
          config.defaultSpace ? ` (space: ${config.defaultSpace})` : ''
        }`,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (/invalid_grant|invalid_client|unauthorized/i.test(msg)) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Google rejected the service account assertion: ${msg}. Check the key has not been revoked, and that the Chat API is enabled for the project.`,
        };
      }
      if (/DECODER|pkcs8|key/i.test(msg)) {
        return {
          ok: false,
          reason: 'unknown',
          hint: `The private key could not be parsed: ${msg}. Copy \`private_key\` verbatim from the JSON key file, including the BEGIN/END lines.`,
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Google Chat bots cannot upload attachments through the messages API — link the file (e.g. in Drive) instead.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error(
      'Google Chat attachment download requires the media API and Drive scopes, which this adapter does not request.',
    );
  }

  return {
    channel: 'googlechat',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getAccessToken,
  };
}
