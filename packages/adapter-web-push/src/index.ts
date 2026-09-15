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
 * A browser's `PushSubscription`, as `JSON.stringify(subscription)` produces
 * it. Pass the whole thing as `contact.channelUserId` — endpoint, p256dh and
 * auth are all required to encrypt, and keeping them together means a
 * subscription survives `sendBulk` as one opaque value.
 */
export interface PushSubscription {
  endpoint: string;
  keys: {
    /** The client's P-256 public key, base64url, uncompressed (65 bytes). */
    p256dh: string;
    /** The client's auth secret, base64url (16 bytes). */
    auth: string;
  };
  expirationTime?: number | null;
}

export interface WebPushConfig {
  /**
   * VAPID public key, base64url — the same value you hand
   * `pushManager.subscribe({ applicationServerKey })` in the browser. Change it
   * and every existing subscription stops working.
   */
  publicKey: string;
  /** VAPID private key, base64url (32 bytes). */
  privateKey: string;
  /**
   * VAPID `sub` claim: `mailto:you@example.com` or your site's https URL.
   * Push services use it to contact you when something is wrong; some reject
   * anything else.
   */
  subject: string;
  /** Default notification title, used when a message sets none. */
  defaultTitle?: string;
  /** Seconds a push service should hold an undelivered message. Default 2419200 (28 days). */
  defaultTtl?: number;
}

export interface WebPushAdapter extends Adapter {
  readonly channel: 'web-push';
  /**
   * Encrypt a payload for a subscription without sending it — the aes128gcm
   * body from RFC 8291. Exposed for debugging a push that arrives empty.
   */
  encrypt(subscription: PushSubscription, payload: string): Promise<Uint8Array>;
  /** Mint the VAPID `Authorization` header for a push endpoint. */
  vapidHeader(endpoint: string): Promise<string>;
}

/**
 * The browser shows the notification, so there is no media upload and no reply
 * path. An image rides in the payload and the service worker decides what to
 * do with it; `actions` are the notification's own buttons, which the browser
 * delivers to the service worker rather than back to us — so `buttons` stays
 * false, because nothing returns through this channel.
 */
const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: false, audio: false, file: false },
  interactive: { buttons: false, quickReplies: false },
  templates: false,
  reactions: false,
  typing: false,
};

const DEFAULT_TTL = 2_419_200; // 28 days, the maximum most services accept

// ---------- base64url ----------

export function b64urlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

export function b64urlDecode(input: string): Uint8Array {
  const padded = input.replace(/-/g, '+').replace(/_/g, '/');
  const binary = atob(padded + '='.repeat((4 - (padded.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

/** An HKDF label, which RFC 8291 always terminates with a zero byte. */
function label(text: string): Uint8Array {
  return new TextEncoder().encode(`${text}\0`);
}

async function hkdf(
  salt: Uint8Array,
  ikm: Uint8Array,
  info: Uint8Array,
  bytes: number,
): Promise<Uint8Array> {
  const key = await globalThis.crypto.subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, [
    'deriveBits',
  ]);
  const bits = await globalThis.crypto.subtle.deriveBits(
    { name: 'HKDF', hash: 'SHA-256', salt: salt as BufferSource, info: info as BufferSource },
    key,
    bytes * 8,
  );
  return new Uint8Array(bits);
}

/**
 * Encrypt a payload for one subscription, per RFC 8291 (`aes128gcm`).
 *
 * The wire format is a header the recipient needs in order to derive the same
 * key — salt, record size, and our ephemeral public key — followed by the
 * AES-GCM ciphertext:
 *
 *     salt(16) || record_size(4) || key_len(1) || as_public(65) || ciphertext
 *
 * `ephemeral` is injectable so a test can pin the keypair and decrypt the
 * result; production always generates a fresh one per message, which is the
 * point of the scheme.
 */
export async function encryptPayload(
  subscription: PushSubscription,
  payload: string,
  options: { salt?: Uint8Array; ephemeral?: CryptoKeyPair; recordSize?: number } = {},
): Promise<Uint8Array> {
  const subtle = globalThis.crypto.subtle;
  const uaPublicBytes = b64urlDecode(subscription.keys.p256dh);
  const authSecret = b64urlDecode(subscription.keys.auth);

  const uaPublic = await subtle.importKey(
    'raw',
    uaPublicBytes as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );

  const ephemeral =
    options.ephemeral ??
    ((await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
      'deriveBits',
    ])) as CryptoKeyPair);
  const asPublicBytes = new Uint8Array(await subtle.exportKey('raw', ephemeral.publicKey));

  const sharedSecret = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: uaPublic }, ephemeral.privateKey, 256),
  );

  // The auth secret is the salt here, which is what binds the derived key to
  // this particular subscription rather than to the ECDH exchange alone.
  const ikm = await hkdf(
    authSecret,
    sharedSecret,
    concat(label('WebPush: info'), uaPublicBytes, asPublicBytes),
    32,
  );

  const salt = options.salt ?? globalThis.crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, label('Content-Encoding: aes128gcm'), 16);
  const nonce = await hkdf(salt, ikm, label('Content-Encoding: nonce'), 12);

  const key = await subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['encrypt']);
  // 0x02 marks the final record. Everything here is a single record, so the
  // delimiter is always the last-record one.
  const plaintext = concat(new TextEncoder().encode(payload), new Uint8Array([0x02]));
  const ciphertext = new Uint8Array(
    await subtle.encrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, plaintext as BufferSource),
  );

  const recordSize = options.recordSize ?? 4096;
  const header = new Uint8Array(5);
  new DataView(header.buffer).setUint32(0, recordSize, false);
  header[4] = asPublicBytes.length;

  return concat(salt, header, asPublicBytes, ciphertext);
}

/**
 * Sign the VAPID JWT identifying this application server.
 *
 * Web Crypto cannot import a bare 32-byte scalar, so the private key is
 * reassembled as a JWK with the x/y coordinates taken from the public key —
 * the two halves of the uncompressed point after its 0x04 prefix.
 */
export async function createVapidJwt(opts: {
  audience: string;
  subject: string;
  publicKey: string;
  privateKey: string;
  nowSec?: number;
  ttlSec?: number;
}): Promise<string> {
  const now = opts.nowSec ?? Math.floor(Date.now() / 1000);
  const publicBytes = b64urlDecode(opts.publicKey);
  if (publicBytes.length !== 65 || publicBytes[0] !== 0x04) {
    throw new Error(
      'VAPID publicKey must be a 65-byte uncompressed P-256 point in base64url (the value you pass to pushManager.subscribe).',
    );
  }

  const jwk: JsonWebKey = {
    kty: 'EC',
    crv: 'P-256',
    x: b64urlEncode(publicBytes.slice(1, 33)),
    y: b64urlEncode(publicBytes.slice(33, 65)),
    d: opts.privateKey.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, ''),
    ext: true,
  };

  const key = await globalThis.crypto.subtle.importKey(
    'jwk',
    jwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );

  const encode = (obj: unknown) => b64urlEncode(new TextEncoder().encode(JSON.stringify(obj)));
  // 12 hours: comfortably inside the 24-hour ceiling services enforce, so a
  // clock a little out of step does not produce a rejected token.
  const signingInput = `${encode({ typ: 'JWT', alg: 'ES256' })}.${encode({
    aud: opts.audience,
    exp: now + (opts.ttlSec ?? 12 * 60 * 60),
    sub: opts.subject,
  })}`;

  const sig = await globalThis.crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' },
    key,
    new TextEncoder().encode(signingInput),
  );
  return `${signingInput}.${b64urlEncode(new Uint8Array(sig))}`;
}

/**
 * Split a push service's response into the two questions the core asks.
 *
 * 404 and 410 are the whole reason to wire Web Push into a suppression store:
 * a browser that cleared site data, or a user who revoked permission, leaves an
 * endpoint that fails forever.
 */
export function classifyWebPushStatus(status: number): {
  permanent?: boolean;
  retryable?: boolean;
} {
  // The subscription is gone. Every push service agrees on these two.
  if (status === 404 || status === 410) return { permanent: true, retryable: false };
  if (status === 429 || status === 502 || status === 503 || status === 504) {
    return { permanent: false, retryable: true };
  }
  // 400 malformed, 401/403 bad VAPID, 413 payload too large — our fault, not
  // the subscriber's, so unretryable without blaming the endpoint.
  if (status === 400 || status === 401 || status === 403 || status === 413) {
    return { retryable: false };
  }
  return {};
}

/** Accept a JSON subscription, or a bare endpoint with the keys in metadata. */
function parseSubscription(
  channelUserId: string,
  metadata: Record<string, unknown> | undefined,
): PushSubscription | null {
  const trimmed = channelUserId.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as PushSubscription;
      if (parsed.endpoint && parsed.keys?.p256dh && parsed.keys?.auth) return parsed;
      return null;
    } catch {
      return null;
    }
  }

  const p256dh = metadata?.['p256dh'];
  const auth = metadata?.['auth'];
  if (!trimmed || typeof p256dh !== 'string' || typeof auth !== 'string') return null;
  return { endpoint: trimmed, keys: { p256dh, auth } };
}

/**
 * Web Push adapter for Msgly — browser notifications with no vendor in the
 * middle.
 *
 * **What a subscription is.** The browser hands your page a `PushSubscription`
 * with an endpoint on whatever push service that browser uses (FCM for Chrome,
 * Mozilla's for Firefox, Apple's for Safari) plus two keys. Send the whole
 * JSON to your server and use it as `contact.channelUserId`.
 *
 * **Encryption is mandatory.** A payload is encrypted end-to-end for that one
 * subscription (RFC 8291, `aes128gcm`), so the push service relays bytes it
 * cannot read. There is no unencrypted payload option.
 *
 * **VAPID** identifies you to the push service: an ES256 JWT plus your public
 * key, on every request. The public key must be the same one the browser
 * subscribed with — changing it invalidates every subscription you hold.
 *
 * **Receive.** Push is one-way. The notification's own action buttons are
 * delivered to your service worker, not back here, so `handleWebhook` always
 * returns nothing.
 */
export function createWebPushAdapter(config: WebPushConfig): WebPushAdapter {
  async function vapidHeader(endpoint: string): Promise<string> {
    const audience = new URL(endpoint).origin;
    const jwt = await createVapidJwt({
      audience,
      subject: config.subject,
      publicKey: config.publicKey,
      privateKey: config.privateKey,
    });
    return `vapid t=${jwt}, k=${config.publicKey}`;
  }

  async function encrypt(
    subscription: PushSubscription,
    payload: string,
  ): Promise<Uint8Array> {
    return encryptPayload(subscription, payload);
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

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const subscription = parseSubscription(
      message.contact.channelUserId,
      message.metadata,
    );
    if (!subscription) {
      return failure(
        message.id,
        message.contact.channelUserId,
        'web_push_invalid_subscription',
        'contact.channelUserId must be a JSON PushSubscription (endpoint + keys.p256dh + keys.auth), or the endpoint URL with metadata.p256dh and metadata.auth alongside it.',
        { retryable: false },
      );
    }

    const content = message.content;
    const title = (message.metadata?.['title'] as string | undefined) ?? config.defaultTitle;

    let body: string;
    let image: string | undefined;
    switch (content.type) {
      case 'text':
        body = content.text;
        break;
      case 'image':
        if (content.mediaRef.kind !== 'url') {
          return failure(
            message.id,
            subscription.endpoint,
            'web_push_media_url_required',
            'Web Push has no media upload — the browser fetches the image, so pass mediaRef { kind: "url" }.',
            { retryable: false },
          );
        }
        body = content.caption ?? '';
        image = content.mediaRef.value;
        break;
      default:
        return failure(
          message.id,
          subscription.endpoint,
          'web_push_unsupported_content',
          `Web Push sends a notification payload — text, or image with a URL (received: ${content.type}).`,
          { retryable: false },
        );
    }

    // The service worker receives exactly this object, so the shape is the
    // contract between the two halves of an application.
    const payload = JSON.stringify({
      ...(title ? { title } : {}),
      body,
      ...(image ? { image } : {}),
      ...(message.metadata?.['data'] ? { data: message.metadata['data'] } : {}),
      ...(message.metadata?.['icon'] ? { icon: message.metadata['icon'] } : {}),
      ...(message.metadata?.['tag'] ? { tag: message.metadata['tag'] } : {}),
    });

    let encrypted: Uint8Array;
    let authorization: string;
    try {
      encrypted = await encryptPayload(subscription, payload);
      authorization = await vapidHeader(subscription.endpoint);
    } catch (err) {
      return failure(
        message.id,
        subscription.endpoint,
        'web_push_crypto_error',
        err instanceof Error ? err.message : String(err),
        { retryable: false },
      );
    }

    const headers: Record<string, string> = {
      authorization,
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: String(
        (message.metadata?.['ttl'] as number | undefined) ?? config.defaultTtl ?? DEFAULT_TTL,
      ),
    };
    const urgency = message.metadata?.['urgency'];
    if (typeof urgency === 'string') headers['urgency'] = urgency;
    // A Topic replaces any undelivered message with the same one, which is how
    // you avoid a stack of stale notifications after a device comes back.
    const topic = message.metadata?.['topic'];
    if (typeof topic === 'string') headers['topic'] = topic;

    let res: Response;
    try {
      res = await fetch(subscription.endpoint, {
        method: 'POST',
        headers,
        body: encrypted as BodyInit,
      });
    } catch (err) {
      return failure(
        message.id,
        subscription.endpoint,
        'web_push_network_error',
        err instanceof Error ? err.message : String(err),
        { permanent: false },
      );
    }

    if (res.status >= 200 && res.status < 300) {
      return {
        messageId: message.id,
        // Most services return a location for the queued message; some do not.
        ...(res.headers.get('location') ? { externalId: res.headers.get('location')! } : {}),
        status: 'sent',
        timestamp: new Date().toISOString(),
        recipientId: subscription.endpoint,
      };
    }

    const text = await res.text().catch(() => '');
    // Push services answer a 429 with Retry-After. Surfaced in the message
    // because a receipt has nowhere better to put it, and the caller needs it
    // to pace a retry sensibly.
    const retryAfter = res.headers.get('retry-after');
    const suffix = retryAfter ? ` (retry after ${retryAfter})` : '';

    return failure(
      message.id,
      subscription.endpoint,
      `web_push_${res.status}`,
      `${text || `HTTP ${res.status}`}${suffix}`,
      classifyWebPushStatus(res.status),
    );
  }

  /** Push is one-way — notification clicks reach the service worker, not us. */
  async function handleWebhook(_req: WebhookRequest): Promise<InboundMessage[]> {
    return [];
  }

  /** No webhook means nothing to verify. */
  async function verifySignature(_req: WebhookRequest): Promise<boolean> {
    return true;
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.publicKey || !config.privateKey) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WebPushConfig.publicKey and privateKey are required. Generate a VAPID pair once and keep it: the public key is what browsers subscribe with, so rotating it invalidates every existing subscription.',
      };
    }
    if (!/^(mailto:|https:)/.test(config.subject)) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WebPushConfig.subject must be a mailto: address or an https URL — some push services reject anything else.',
      };
    }

    // There is no endpoint to call: VAPID is self-signed and only a real push
    // service validates it. Signing a token proves the pair is usable, which is
    // as far as an offline check can honestly go.
    try {
      await createVapidJwt({
        audience: 'https://example.com',
        subject: config.subject,
        publicKey: config.publicKey,
        privateKey: config.privateKey,
      });
      return { ok: true, accountInfo: `${config.subject} (VAPID ${config.publicKey.slice(0, 12)}…)` };
    } catch (err) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: `The VAPID key pair could not be used to sign: ${err instanceof Error ? err.message : String(err)}`,
      };
    }
  }

  async function uploadMedia(_file: MediaFile): Promise<MediaReference> {
    throw new Error(
      'Web Push has no media upload — host the image yourself and pass mediaRef { kind: "url" }.',
    );
  }

  async function downloadMedia(_ref: MediaReference): Promise<MediaFile> {
    throw new Error('Web Push has no media download — push is one-way.');
  }

  return {
    channel: 'web-push',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyCredentials,
    uploadMedia,
    downloadMedia,
    encrypt,
    vapidHeader,
  };
}
