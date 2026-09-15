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

/**
 * One APNs request/response, reduced to the parts an adapter needs.
 *
 * This exists because APNs speaks HTTP/2 only and `fetch` does not: Node's
 * fetch is undici over HTTP/1.1, and feeding it APNs' binary frames throws.
 * The default transport therefore uses `node:http2`, and this seam lets a
 * non-Node runtime — or a test — supply its own without the adapter caring.
 */
export interface ApnsTransport {
  (request: {
    url: string;
    headers: Record<string, string>;
    body: string;
  }): Promise<{
    status: number;
    headers: Record<string, string>;
    body: string;
  }>;
}

export interface ApnsConfig {
  /** Apple Developer Team ID — 10 characters, from developer.apple.com → Membership. */
  teamId: string;
  /** Key ID of the .p8 auth key, from Certificates, Identifiers & Profiles → Keys. */
  keyId: string;
  /**
   * Contents of the .p8 auth key, including the BEGIN/END lines. An ES256
   * PKCS#8 key; escaped `\n` sequences are handled, so an env var works.
   */
  privateKey: string;
  /**
   * APNs topic — your app's bundle id (`com.acme.app`). Some push types need a
   * suffix, e.g. `com.acme.app.voip`; pass it per message via
   * `metadata.topic` when it differs.
   */
  topic: string;
  /**
   * Send to the sandbox gateway instead of production. Development builds
   * registered with the sandbox produce tokens that production rejects with
   * `BadDeviceToken`, which is the single most common APNs mistake.
   */
  sandbox?: boolean;
  /** Default notification title, used when a message sets none. */
  defaultTitle?: string;
  /**
   * Payload key carrying an image URL for rich notifications. Displaying it
   * requires a Notification Service Extension in the app — APNs itself never
   * fetches the image. Defaults to `image-url`.
   */
  imageUrlKey?: string;
  /** Override the APNs host. */
  apiBase?: string;
  /** Supply your own HTTP/2 transport. Defaults to one built on `node:http2`. */
  transport?: ApnsTransport;
}

export interface ApnsAdapter extends Adapter {
  readonly channel: 'apns';
  /** Mint (and cache) the ES256 provider token APNs authenticates with. */
  getProviderToken(): Promise<string>;
  /**
   * Send a payload APNs supports but this adapter does not model — a silent
   * background refresh, a VoIP push, a Live Activity update, a critical alert.
   *
   * `headers` are merged over the defaults, so `apns-push-type` and
   * `apns-priority` can be set to whatever the payload requires.
   */
  sendRaw(
    deviceToken: string,
    payload: Record<string, unknown>,
    headers?: Record<string, string>,
  ): Promise<DeliveryReceipt>;
}

const PRODUCTION_HOST = 'https://api.push.apple.com';
const SANDBOX_HOST = 'https://api.sandbox.push.apple.com';

/**
 * Push is one-way: a device cannot reply through APNs, and there is no media
 * upload — an image is a URL the app's own extension fetches.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

/**
 * APNs reasons that mean this device token is dead.
 *
 * These are the whole reason to wire push into a suppression store: an app
 * uninstall leaves a token that fails forever, and retrying it wastes requests
 * and inflates failure rates.
 */
const RECIPIENT_FATAL_REASONS = new Set([
  'BadDeviceToken', // malformed, or minted for the other environment
  'Unregistered', // the app was uninstalled; `timestamp` says when
  'DeviceTokenNotForTopic', // the token belongs to a different app
]);

/**
 * Reasons a retry can plausibly fix: throttles and Apple-side faults.
 */
const TRANSIENT_REASONS = new Set([
  'TooManyRequests',
  'TooManyProviderTokenUpdates',
  'InternalServerError',
  'ServiceUnavailable',
  'Shutdown', // the server is closing this connection; reconnect and resend
]);

/**
 * Reasons a retry will never fix: bad credentials, a malformed request, an
 * oversized payload. Retrying these burns requests to reach the same failure.
 */
const FATAL_REASONS = new Set([
  'BadCertificate',
  'BadCertificateEnvironment',
  'BadCollapseId',
  'BadExpirationDate',
  'BadMessageId',
  'BadPath',
  'BadPriority',
  'BadTopic',
  'DuplicateHeaders',
  'ExpiredProviderToken',
  'Forbidden',
  'IdleTimeout',
  'InvalidProviderToken',
  'InvalidPushType',
  'MethodNotAllowed',
  'MissingDeviceToken',
  'MissingProviderToken',
  'MissingTopic',
  'PayloadEmpty',
  'PayloadTooLarge',
  'TopicDisallowed',
  'UnsupportedPushType',
]);

/**
 * Split an APNs reason into the two questions the core actually asks: should
 * we retry, and should we suppress this device.
 *
 * They are different questions. `ExpiredProviderToken` is permanently
 * unretryable and says nothing about the device — marking it recipient-fatal
 * would suppress every device you touched while a key was stale.
 */
export function classifyApnsReason(reason: string | undefined): {
  permanent?: boolean;
  retryable?: boolean;
} {
  if (!reason) return {};
  if (RECIPIENT_FATAL_REASONS.has(reason)) return { permanent: true, retryable: false };
  if (TRANSIENT_REASONS.has(reason)) return { permanent: false, retryable: true };
  if (FATAL_REASONS.has(reason)) return { retryable: false };
  return {};
}

function b64urlEncode(input: string | Uint8Array): string {
  const bytes = typeof input === 'string' ? new TextEncoder().encode(input) : input;
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

/** Strip PEM armour to DER, tolerating the escaped `\n` env vars produce. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/\\n/g, '\n')
    .replace(/-----BEGIN [^-]+-----/, '')
    .replace(/-----END [^-]+-----/, '')
    .replace(/\s+/g, '');
  const binary = atob(body);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

/**
 * Mint the ES256 provider token.
 *
 * Web Crypto's ECDSA signatures come out as raw `r || s`, which is exactly what
 * JWS ES256 wants — no DER unwrapping needed, unlike the RS256 path.
 */
export async function createProviderToken(opts: {
  teamId: string;
  keyId: string;
  privateKeyPem: string;
  nowSec?: number;
}): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const signingInput =
    `${b64urlEncode(JSON.stringify({ alg: 'ES256', kid: opts.keyId }))}.` +
    b64urlEncode(JSON.stringify({ iss: opts.teamId, iat: now }));

  const key = await globalThis.crypto.subtle.importKey(
    'pkcs8',
    pemToDer(opts.privateKeyPem) as BufferSource,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * The default transport, on `node:http2`.
 *
 * Imported lazily so the package still loads in a runtime without it — the
 * error only fires if you actually send without supplying `config.transport`.
 */
function createHttp2Transport(): ApnsTransport {
  return async ({ url, headers, body }) => {
    let http2: typeof import('node:http2');
    try {
      http2 = await import('node:http2');
    } catch {
      throw new Error(
        'APNs needs HTTP/2, which this runtime does not provide via `node:http2`. ' +
          'Pass ApnsConfig.transport with your own HTTP/2 client.',
      );
    }

    const target = new URL(url);
    return new Promise((resolve, reject) => {
      const session = http2.connect(target.origin);
      session.on('error', reject);

      const req = session.request({
        ...headers,
        ':method': 'POST',
        ':path': `${target.pathname}${target.search}`,
      });

      let status = 0;
      const resHeaders: Record<string, string> = {};
      req.on('response', (h) => {
        status = Number(h[':status'] ?? 0);
        for (const [k, v] of Object.entries(h)) {
          if (!k.startsWith(':')) resHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v ?? '');
        }
      });

      let data = '';
      req.setEncoding('utf8');
      req.on('data', (chunk: string) => {
        data += chunk;
      });
      req.on('error', (err) => {
        session.close();
        reject(err);
      });
      req.on('end', () => {
        session.close();
        resolve({ status, headers: resHeaders, body: data });
      });

      req.end(body);
    });
  };
}

/**
 * Apple Push Notification service adapter for Msgly — push to iOS, iPadOS,
 * macOS, watchOS and Safari.
 *
 * **Auth.** A provider token: an ES256 JWT signed with a .p8 key, sent as
 * `authorization: bearer`. Apple accepts a token for an hour but refuses
 * regeneration more than once every 20 minutes
 * (`TooManyProviderTokenUpdates`), so the token is cached with both bounds in
 * mind.
 *
 * **Transport.** APNs is HTTP/2-only and `fetch` cannot speak it. The default
 * transport uses `node:http2`, which makes this adapter Node-first —
 * `config.transport` is the escape hatch for other runtimes.
 *
 * **Send.** `POST /3/device/{token}`, where the contact's `channelUserId` is
 * the device token. The `apns-id` header is set from the message id, so the
 * same message is idempotent across retries.
 *
 * **Environments.** A token minted by a development build only works against
 * the sandbox host, and production rejects it as `BadDeviceToken`. Set
 * `sandbox: true` to match.
 *
 * **Receive.** Push is one-way — `handleWebhook` always returns nothing. There
 * is no delivery webhook either; Apple's only feedback is the `Unregistered`
 * reason on a later send, which this adapter marks as recipient-fatal so a
 * suppression store can act on it.
 */
export function createApnsAdapter(config: ApnsConfig): ApnsAdapter {
  const apiBase = config.apiBase ?? (config.sandbox ? SANDBOX_HOST : PRODUCTION_HOST);
  const imageUrlKey = config.imageUrlKey ?? 'image-url';
  const transport = config.transport ?? createHttp2Transport();

  let token: string | null = null;
  let mintedAt = 0;

  async function getProviderToken(): Promise<string> {
    // Apple expires a provider token after an hour and rejects regeneration
    // more often than once every 20 minutes, so 50 sits safely between.
    const ageMs = Date.now() - mintedAt;
    if (token && ageMs < 50 * 60 * 1000) return token;
    token = await createProviderToken({
      teamId: config.teamId,
      keyId: config.keyId,
      privateKeyPem: config.privateKey,
    });
    mintedAt = Date.now();
    return token;
  }

  function failure(
    messageId: string,
    recipientId: string,
    code: string,
    message: string,
    classified: { permanent?: boolean; retryable?: boolean } = {},
  ): DeliveryReceipt {
    return {
      messageId,
      status: 'failed',
      timestamp: new Date().toISOString(),
      recipientId,
      error: { code, message, ...classified },
    };
  }

  async function post(
    deviceToken: string,
    payload: Record<string, unknown>,
    extraHeaders: Record<string, string>,
    messageId: string,
  ): Promise<DeliveryReceipt> {
    if (!deviceToken) {
      return failure(
        messageId,
        deviceToken,
        'apns_missing_device_token',
        'contact.channelUserId must be the device token APNs registered for this app.',
        { retryable: false },
      );
    }

    let providerToken: string;
    try {
      providerToken = await getProviderToken();
    } catch (err) {
      return failure(
        messageId,
        deviceToken,
        'apns_auth_error',
        err instanceof Error ? err.message : String(err),
        { retryable: false },
      );
    }

    const headers: Record<string, string> = {
      authorization: `bearer ${providerToken}`,
      'apns-topic': config.topic,
      'apns-push-type': 'alert',
      'apns-priority': '10',
      'content-type': 'application/json',
      ...extraHeaders,
    };

    let res: Awaited<ReturnType<ApnsTransport>>;
    try {
      res = await transport({
        url: `${apiBase}/3/device/${encodeURIComponent(deviceToken)}`,
        headers,
        body: JSON.stringify(payload),
      });
    } catch (err) {
      // The connection, not the message — never recipient-fatal.
      return failure(
        messageId,
        deviceToken,
        'apns_network_error',
        err instanceof Error ? err.message : String(err),
        { permanent: false },
      );
    }

    if (res.status === 200) {
      return {
        messageId,
        // APNs echoes the id it accepted, which is the only handle you get.
        externalId: res.headers['apns-id'] ?? headers['apns-id'],
        status: 'sent',
        timestamp: new Date().toISOString(),
        recipientId: deviceToken,
      };
    }

    const parsed = (() => {
      try {
        return JSON.parse(res.body) as { reason?: string; timestamp?: number };
      } catch {
        return {} as { reason?: string; timestamp?: number };
      }
    })();

    const reason = parsed.reason;
    // `timestamp` accompanies Unregistered and says when the token died —
    // useful for deciding whether a newer token has since replaced it.
    const since =
      parsed.timestamp !== undefined
        ? ` (token invalid since ${new Date(parsed.timestamp).toISOString()})`
        : '';

    return failure(
      messageId,
      deviceToken,
      `apns_${reason ?? res.status}`,
      `${reason ?? `HTTP ${res.status}`}${since}`,
      classifyApnsReason(reason),
    );
  }

  function alertPayload(
    title: string | undefined,
    body: string,
    imageUrl?: string,
  ): Record<string, unknown> {
    return {
      aps: {
        alert: { ...(title ? { title } : {}), body },
        sound: 'default',
        // Without this the extension never runs, so the image never appears.
        ...(imageUrl ? { 'mutable-content': 1 } : {}),
      },
      ...(imageUrl ? { [imageUrlKey]: imageUrl } : {}),
    };
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const deviceToken = message.contact.channelUserId;
    const content = message.content;
    const title =
      (message.metadata?.['title'] as string | undefined) ?? config.defaultTitle;

    let payload: Record<string, unknown>;
    switch (content.type) {
      case 'text':
        payload = alertPayload(title, content.text);
        break;

      case 'image': {
        if (content.mediaRef.kind !== 'url') {
          return failure(
            message.id,
            deviceToken,
            'apns_media_url_required',
            'APNs has no media upload — the app\'s Notification Service Extension fetches the image itself, so pass mediaRef { kind: "url" }.',
            { retryable: false },
          );
        }
        payload = alertPayload(title, content.caption ?? '', content.mediaRef.value);
        break;
      }

      default:
        return failure(
          message.id,
          deviceToken,
          'apns_unsupported_content',
          `APNs sends notifications — text, or image with a URL (received: ${content.type}). Use sendRaw() for background, VoIP or Live Activity payloads.`,
          { retryable: false },
        );
    }

    const headers: Record<string, string> = {};
    // The library's ids are UUIDs, which is the format APNs requires — passing
    // it makes a retried send idempotent rather than a second notification.
    if (/^[0-9a-f-]{36}$/i.test(message.id)) headers['apns-id'] = message.id;
    const topic = message.metadata?.['topic'];
    if (typeof topic === 'string') headers['apns-topic'] = topic;
    const collapseId = message.metadata?.['collapseId'];
    if (typeof collapseId === 'string') headers['apns-collapse-id'] = collapseId;
    const expiration = message.metadata?.['expiration'];
    if (typeof expiration === 'number') headers['apns-expiration'] = String(expiration);

    return post(deviceToken, payload, headers, message.id);
  }

  async function sendRaw(
    deviceToken: string,
    payload: Record<string, unknown>,
    headers: Record<string, string> = {},
  ): Promise<DeliveryReceipt> {
    return post(deviceToken, payload, headers, deviceToken);
  }

  /** Push is one-way — there is no inbound channel to parse. */
  async function handleWebhook(_req: WebhookRequest): Promise<InboundMessage[]> {
    return [];
  }

  /** No webhook means nothing to verify. */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.teamId || !config.keyId || !config.privateKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ApnsConfig.teamId, keyId and privateKey are all required. The Team ID is at developer.apple.com → Membership; the Key ID and the .p8 file come from Certificates, Identifiers & Profiles → Keys (the .p8 downloads once and cannot be re-downloaded).',
      };
    }
    if (!config.topic) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'ApnsConfig.topic is required — your app\'s bundle id, e.g. com.acme.app.',
      };
    }

    // APNs has no "whoami". The documented way to prove a key works is to push
    // to a deliberately invalid token: `BadDeviceToken` means Apple accepted
    // the credentials and rejected only the token, which is the answer we want.
    try {
      const probe = await sendRaw('0'.repeat(64), { aps: {} });
      const code = probe.error?.code ?? '';
      if (code === 'apns_BadDeviceToken' || probe.status === 'sent') {
        return { ok: true, accountInfo: `${config.topic} (team ${config.teamId}, key ${config.keyId})` };
      }
      if (code === 'apns_InvalidProviderToken' || code === 'apns_ExpiredProviderToken') {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: 'Apple rejected the provider token. Check teamId and keyId match the .p8 file, and that the key has not been revoked.',
        };
      }
      if (code === 'apns_TopicDisallowed' || code === 'apns_BadTopic') {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `Apple rejected the topic "${config.topic}". It must be the app's bundle id, and the key must be enabled for that app.`,
        };
      }
      if (code === 'apns_auth_error') {
        return {
          ok: false,
          reason: 'unknown',
          hint: `The .p8 key could not be parsed: ${probe.error?.message}. Copy it verbatim, including the BEGIN/END lines.`,
        };
      }
      return { ok: false, reason: 'unknown', hint: probe.error?.message ?? 'unknown APNs failure' };
    } catch (err) {
      return {
        ok: false,
        reason: 'network_error',
        hint: err instanceof Error ? err.message : String(err),
      };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'APNs has no media upload — host the image yourself and pass mediaRef { kind: "url" }. Displaying it needs a Notification Service Extension in the app.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('APNs has no media download — push is one-way.');
  }

  return {
    channel: 'apns',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    getProviderToken,
    sendRaw,
  };
}
