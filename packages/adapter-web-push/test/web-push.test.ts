import { describe, expect, it, vi } from 'vitest';

import {
  b64urlDecode,
  b64urlEncode,
  classifyWebPushStatus,
  createVapidJwt,
  createWebPushAdapter,
  encryptPayload,
  type PushSubscription,
} from '../src/index.js';

const subtle = globalThis.crypto.subtle;

/** A VAPID pair in the shape the config wants: base64url public point + scalar. */
async function generateVapidKeys() {
  const pair = (await subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
    'verify',
  ])) as CryptoKeyPair;
  const publicKey = b64urlEncode(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const jwk = await subtle.exportKey('jwk', pair.privateKey);
  return { publicKey, privateKey: jwk.d!, verifyKey: pair.publicKey };
}

/** A browser subscription, plus the private half so a test can decrypt. */
async function generateSubscription(endpoint = 'https://push.example.com/s/abc') {
  const pair = (await subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, [
    'deriveBits',
  ])) as CryptoKeyPair;
  const p256dh = b64urlEncode(new Uint8Array(await subtle.exportKey('raw', pair.publicKey)));
  const auth = b64urlEncode(globalThis.crypto.getRandomValues(new Uint8Array(16)));
  const subscription: PushSubscription = { endpoint, keys: { p256dh, auth } };
  return { subscription, privateKey: pair.privateKey, publicKeyBytes: b64urlDecode(p256dh) };
}

/**
 * Decrypt an aes128gcm body the way a browser would, so the test proves the
 * payload is genuinely readable rather than merely well-shaped.
 */
async function decrypt(
  body: Uint8Array,
  uaPrivate: CryptoKey,
  uaPublicBytes: Uint8Array,
  authSecret: Uint8Array,
): Promise<string> {
  const salt = body.slice(0, 16);
  const keyLen = body[20]!;
  const asPublicBytes = body.slice(21, 21 + keyLen);
  const ciphertext = body.slice(21 + keyLen);

  const asPublic = await subtle.importKey(
    'raw',
    asPublicBytes as BufferSource,
    { name: 'ECDH', namedCurve: 'P-256' },
    false,
    [],
  );
  const shared = new Uint8Array(
    await subtle.deriveBits({ name: 'ECDH', public: asPublic }, uaPrivate, 256),
  );

  const enc = new TextEncoder();
  const concat = (...parts: Uint8Array[]) => {
    const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.length;
    }
    return out;
  };
  const hkdf = async (s: Uint8Array, ikm: Uint8Array, info: Uint8Array, n: number) => {
    const k = await subtle.importKey('raw', ikm as BufferSource, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(
      await subtle.deriveBits(
        { name: 'HKDF', hash: 'SHA-256', salt: s as BufferSource, info: info as BufferSource },
        k,
        n * 8,
      ),
    );
  };

  const ikm = await hkdf(
    authSecret,
    shared,
    concat(enc.encode('WebPush: info\0'), uaPublicBytes, asPublicBytes),
    32,
  );
  const cek = await hkdf(salt, ikm, enc.encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(salt, ikm, enc.encode('Content-Encoding: nonce\0'), 12);

  const key = await subtle.importKey('raw', cek as BufferSource, 'AES-GCM', false, ['decrypt']);
  const plain = new Uint8Array(
    await subtle.decrypt({ name: 'AES-GCM', iv: nonce as BufferSource }, key, ciphertext as BufferSource),
  );
  // Strip the 0x02 last-record delimiter.
  return new TextDecoder().decode(plain.slice(0, -1));
}

describe('RFC 8291 encryption', () => {
  it('produces a body a browser can actually decrypt', async () => {
    const { subscription, privateKey, publicKeyBytes } = await generateSubscription();
    const body = await encryptPayload(subscription, '{"body":"hello"}');

    const plaintext = await decrypt(
      body,
      privateKey,
      publicKeyBytes,
      b64urlDecode(subscription.keys.auth),
    );
    expect(plaintext).toBe('{"body":"hello"}');
  });

  it('lays out the aes128gcm header as salt, record size, key length, key', async () => {
    const { subscription } = await generateSubscription();
    const body = await encryptPayload(subscription, 'x', { recordSize: 4096 });

    expect(body.slice(0, 16)).toHaveLength(16);
    expect(new DataView(body.buffer, body.byteOffset).getUint32(16, false)).toBe(4096);
    expect(body[20]).toBe(65);
    expect(body.slice(21, 86)[0]).toBe(0x04); // uncompressed point prefix
  });

  it('uses a fresh salt and ephemeral key per message', async () => {
    const { subscription } = await generateSubscription();
    const a = await encryptPayload(subscription, 'same');
    const b = await encryptPayload(subscription, 'same');

    expect(a.slice(0, 16)).not.toEqual(b.slice(0, 16));
    expect(a.slice(21, 86)).not.toEqual(b.slice(21, 86));
  });
});

describe('VAPID', () => {
  it('signs a verifiable ES256 token scoped to the endpoint origin', async () => {
    const keys = await generateVapidKeys();
    const jwt = await createVapidJwt({
      audience: 'https://push.example.com',
      subject: 'mailto:ops@acme.com',
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      nowSec: 1_700_000_000,
    });

    const [header, payload, sig] = jwt.split('.');
    const decode = (p: string) => JSON.parse(new TextDecoder().decode(b64urlDecode(p)));
    expect(decode(header!)).toEqual({ typ: 'JWT', alg: 'ES256' });
    expect(decode(payload!)).toEqual({
      aud: 'https://push.example.com',
      exp: 1_700_000_000 + 12 * 60 * 60,
      sub: 'mailto:ops@acme.com',
    });

    const ok = await subtle.verify(
      { name: 'ECDSA', hash: 'SHA-256' },
      keys.verifyKey,
      b64urlDecode(sig!) as BufferSource,
      new TextEncoder().encode(`${header}.${payload}`),
    );
    expect(ok).toBe(true);
  });

  it('rejects a public key that is not an uncompressed P-256 point', async () => {
    await expect(
      createVapidJwt({
        audience: 'https://push.example.com',
        subject: 'mailto:ops@acme.com',
        publicKey: b64urlEncode(new Uint8Array(32)),
        privateKey: 'irrelevant',
      }),
    ).rejects.toThrow(/uncompressed P-256 point/);
  });
});

describe('send', () => {
  const originalFetch = globalThis.fetch;

  function mockFetch(status = 201, headers: Record<string, string> = {}, body = '') {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        status,
        headers: new Headers(headers),
        text: async () => body,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  async function adapterAndSub() {
    const keys = await generateVapidKeys();
    const { subscription, privateKey, publicKeyBytes } = await generateSubscription();
    const adapter = createWebPushAdapter({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:ops@acme.com',
      defaultTitle: 'Acme',
    });
    return { adapter, subscription, privateKey, publicKeyBytes };
  }

  function outbound(subscription: PushSubscription, content: unknown, metadata?: unknown) {
    return {
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'web-push' as const,
      account: { channel: 'web-push' as const, channelAccountId: 'acme' },
      contact: { channel: 'web-push' as const, channelUserId: JSON.stringify(subscription) },
      content,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    } as Parameters<ReturnType<typeof createWebPushAdapter>['send']>[0];
  }

  it('posts an encrypted payload to the subscription endpoint', async () => {
    const calls = mockFetch(201, { location: 'https://push.example.com/m/1' });
    const { adapter, subscription, privateKey, publicKeyBytes } = await adapterAndSub();

    const receipt = await adapter.send(
      outbound(subscription, { type: 'text', text: 'your order shipped' }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('https://push.example.com/m/1');
    expect(receipt.recipientId).toBe(subscription.endpoint);

    expect(calls[0]!.url).toBe(subscription.endpoint);
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['content-encoding']).toBe('aes128gcm');
    expect(headers.authorization).toMatch(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=/);

    const plaintext = await decrypt(
      calls[0]!.init!.body as Uint8Array,
      privateKey,
      publicKeyBytes,
      b64urlDecode(subscription.keys.auth),
    );
    expect(JSON.parse(plaintext)).toEqual({ title: 'Acme', body: 'your order shipped' });

    globalThis.fetch = originalFetch;
  });

  it('accepts an endpoint with the keys in metadata', async () => {
    const calls = mockFetch();
    const { adapter, subscription } = await adapterAndSub();

    const receipt = await adapter.send({
      ...outbound(subscription, { type: 'text', text: 'hi' }),
      contact: { channel: 'web-push', channelUserId: subscription.endpoint },
      metadata: { p256dh: subscription.keys.p256dh, auth: subscription.keys.auth },
    });

    expect(receipt.status).toBe('sent');
    expect(calls[0]!.url).toBe(subscription.endpoint);
    globalThis.fetch = originalFetch;
  });

  it('refuses a subscription missing its keys, before encrypting', async () => {
    const calls = mockFetch();
    const { adapter, subscription } = await adapterAndSub();

    const receipt = await adapter.send({
      ...outbound(subscription, { type: 'text', text: 'hi' }),
      contact: { channel: 'web-push', channelUserId: subscription.endpoint },
    });

    expect(receipt.error?.code).toBe('web_push_invalid_subscription');
    expect(receipt.error?.retryable).toBe(false);
    expect(calls).toHaveLength(0);
    globalThis.fetch = originalFetch;
  });

  it('carries TTL, urgency and topic headers', async () => {
    const calls = mockFetch();
    const { adapter, subscription } = await adapterAndSub();

    await adapter.send(
      outbound(subscription, { type: 'text', text: 'hi' }, { ttl: 60, urgency: 'high', topic: 'order-42' }),
    );

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.ttl).toBe('60');
    expect(headers.urgency).toBe('high');
    expect(headers.topic).toBe('order-42');
    globalThis.fetch = originalFetch;
  });

  it('puts an image URL and custom data in the service worker payload', async () => {
    const calls = mockFetch();
    const { adapter, subscription, privateKey, publicKeyBytes } = await adapterAndSub();

    await adapter.send(
      outbound(
        subscription,
        {
          type: 'image',
          mediaRef: { kind: 'url', value: 'https://cdn.example.com/a.png' },
          caption: 'New drop',
        },
        { data: { orderId: '42' }, tag: 'promo' },
      ),
    );

    const plaintext = await decrypt(
      calls[0]!.init!.body as Uint8Array,
      privateKey,
      publicKeyBytes,
      b64urlDecode(subscription.keys.auth),
    );
    expect(JSON.parse(plaintext)).toEqual({
      title: 'Acme',
      body: 'New drop',
      image: 'https://cdn.example.com/a.png',
      data: { orderId: '42' },
      tag: 'promo',
    });
    globalThis.fetch = originalFetch;
  });

  it('treats a gone subscription as recipient-fatal', async () => {
    mockFetch(410, {}, 'push subscription has unsubscribed or expired');
    const { adapter, subscription } = await adapterAndSub();

    const receipt = await adapter.send(outbound(subscription, { type: 'text', text: 'hi' }));

    expect(receipt.error?.code).toBe('web_push_410');
    expect(receipt.error?.permanent).toBe(true);
    expect(receipt.error?.retryable).toBe(false);
    globalThis.fetch = originalFetch;
  });

  it('surfaces Retry-After on a throttle without blaming the subscriber', async () => {
    mockFetch(429, { 'retry-after': '120' }, 'too many requests');
    const { adapter, subscription } = await adapterAndSub();

    const receipt = await adapter.send(outbound(subscription, { type: 'text', text: 'hi' }));

    expect(receipt.error?.retryable).toBe(true);
    expect(receipt.error?.permanent).toBe(false);
    expect(receipt.error?.message).toContain('retry after 120');
    globalThis.fetch = originalFetch;
  });

  it('does not suppress on a rejected VAPID token', async () => {
    mockFetch(401, {}, 'invalid JWT');
    const { adapter, subscription } = await adapterAndSub();

    const receipt = await adapter.send(outbound(subscription, { type: 'text', text: 'hi' }));

    expect(receipt.error?.retryable).toBe(false);
    expect(receipt.error?.permanent).toBeUndefined();
    globalThis.fetch = originalFetch;
  });
});

describe('classification', () => {
  it('only marks a gone subscription permanent', () => {
    expect(classifyWebPushStatus(404)).toEqual({ permanent: true, retryable: false });
    expect(classifyWebPushStatus(410)).toEqual({ permanent: true, retryable: false });
    expect(classifyWebPushStatus(413)).toEqual({ retryable: false });
    expect(classifyWebPushStatus(503)).toEqual({ permanent: false, retryable: true });
    expect(classifyWebPushStatus(418)).toEqual({});
  });
});

describe('verifyCredentials', () => {
  it('accepts a usable VAPID pair', async () => {
    const keys = await generateVapidKeys();
    const result = await createWebPushAdapter({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:ops@acme.com',
    }).verifyCredentials();

    expect(result.ok).toBe(true);
  });

  it('rejects a subject that is not mailto: or https:', async () => {
    const keys = await generateVapidKeys();
    const result = await createWebPushAdapter({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'ops@acme.com',
    }).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('mailto:');
  });
});

describe('inbound', () => {
  it('returns nothing, because push is one-way', async () => {
    const keys = await generateVapidKeys();
    const adapter = createWebPushAdapter({
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
      subject: 'mailto:ops@acme.com',
    });

    expect(
      await adapter.handleWebhook({ headers: {}, rawBody: new Uint8Array(), body: null, query: {} }),
    ).toEqual([]);
  });
});
