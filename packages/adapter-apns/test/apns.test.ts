import { generateKeyPairSync } from 'node:crypto';

import { describe, expect, it, vi } from 'vitest';

import {
  classifyApnsReason,
  createApnsAdapter,
  createProviderToken,
  pemToDer,
  type ApnsTransport,
} from '../src/index.js';

const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const baseConfig = {
  teamId: 'ABCDE12345',
  keyId: 'KEY1234567',
  privateKey: privateKeyPem,
  topic: 'com.acme.app',
};

type Call = { url: string; headers: Record<string, string>; body: string };

/** A transport that records what it was handed and replays canned responses. */
function mockTransport(
  responses: Array<{ status: number; headers?: Record<string, string>; body?: string }> = [
    { status: 200, headers: { 'apns-id': 'apns-abc' } },
  ],
): { transport: ApnsTransport; calls: Call[] } {
  const calls: Call[] = [];
  let i = 0;
  const transport: ApnsTransport = async (req) => {
    calls.push(req);
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return { status: r.status, headers: r.headers ?? {}, body: r.body ?? '' };
  };
  return { transport, calls };
}

function outbound(content: OutboundContent, extra: Record<string, unknown> = {}) {
  return {
    id: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    direction: 'outbound' as const,
    channel: 'apns' as const,
    account: { channel: 'apns' as const, channelAccountId: 'com.acme.app' },
    contact: { channel: 'apns' as const, channelUserId: 'devicetoken123' },
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

type OutboundContent = Parameters<
  ReturnType<typeof createApnsAdapter>['send']
>[0]['content'];

describe('provider token', () => {
  it('signs an ES256 JWT with the key id in the header', async () => {
    const jwt = await createProviderToken({
      teamId: 'ABCDE12345',
      keyId: 'KEY1234567',
      privateKeyPem,
      nowSec: 1_700_000_000,
    });

    const [header, payload, signature] = jwt.split('.');
    const decode = (p: string) =>
      JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

    expect(decode(header!)).toEqual({ alg: 'ES256', kid: 'KEY1234567' });
    expect(decode(payload!)).toEqual({ iss: 'ABCDE12345', iat: 1_700_000_000 });
    // ES256 is a raw r||s pair — 64 bytes — not a DER blob.
    expect(Buffer.from(signature!.replace(/-/g, '+').replace(/_/g, '/'), 'base64')).toHaveLength(64);
  });

  it('reuses a cached token rather than minting one per send', async () => {
    const { transport, calls } = mockTransport();
    const adapter = createApnsAdapter({ ...baseConfig, transport });

    await adapter.send(outbound({ type: 'text', text: 'one' }));
    await adapter.send(outbound({ type: 'text', text: 'two' }));

    // Apple rejects regeneration more than once every 20 minutes, so the same
    // token must be reused across sends.
    expect(calls[0]!.headers.authorization).toBe(calls[1]!.headers.authorization);
  });

  it('parses a PEM with escaped newlines, as an env var produces', () => {
    const escaped = privateKeyPem.replace(/\n/g, '\\n');
    expect(pemToDer(escaped)).toEqual(pemToDer(privateKeyPem));
  });
});

describe('send', () => {
  it('posts an alert to the device path with the topic header', async () => {
    const { transport, calls } = mockTransport();
    const receipt = await createApnsAdapter({
      ...baseConfig,
      defaultTitle: 'Acme',
      transport,
    }).send(outbound({ type: 'text', text: 'your order shipped' }));

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('apns-abc');
    expect(receipt.recipientId).toBe('devicetoken123');

    expect(calls[0]!.url).toBe('https://api.push.apple.com/3/device/devicetoken123');
    expect(calls[0]!.headers['apns-topic']).toBe('com.acme.app');
    expect(calls[0]!.headers['apns-push-type']).toBe('alert');
    expect(calls[0]!.headers.authorization).toMatch(/^bearer /);
    expect(JSON.parse(calls[0]!.body)).toEqual({
      aps: { alert: { title: 'Acme', body: 'your order shipped' }, sound: 'default' },
    });
  });

  it('sends the message id as apns-id, so a retry is not a second notification', async () => {
    const { transport, calls } = mockTransport();
    await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(calls[0]!.headers['apns-id']).toBe('3f2504e0-4f89-11d3-9a0c-0305e82c3301');
  });

  it('uses the sandbox host when asked', async () => {
    const { transport, calls } = mockTransport();
    await createApnsAdapter({ ...baseConfig, sandbox: true, transport }).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(calls[0]!.url).toContain('api.sandbox.push.apple.com');
  });

  it('sets mutable-content for an image, without which the extension never runs', async () => {
    const { transport, calls } = mockTransport();
    await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.example.com/a.png' },
        caption: 'look',
      }),
    );

    expect(JSON.parse(calls[0]!.body)).toEqual({
      aps: { alert: { body: 'look' }, sound: 'default', 'mutable-content': 1 },
      'image-url': 'https://cdn.example.com/a.png',
    });
  });

  it('rejects an uploaded media ref, since APNs never fetches the image', async () => {
    const { transport } = mockTransport();
    const receipt = await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({ type: 'image', mediaRef: { kind: 'platform-id', value: 'abc' } }),
    );

    expect(receipt.error?.code).toBe('apns_media_url_required');
    expect(receipt.error?.retryable).toBe(false);
  });

  it('carries collapseId, expiration and a per-message topic', async () => {
    const { transport, calls } = mockTransport();
    await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound(
        { type: 'text', text: 'hi' },
        { metadata: { collapseId: 'order-42', expiration: 1_700_000_000, topic: 'com.acme.app.voip' } },
      ),
    );

    expect(calls[0]!.headers['apns-collapse-id']).toBe('order-42');
    expect(calls[0]!.headers['apns-expiration']).toBe('1700000000');
    expect(calls[0]!.headers['apns-topic']).toBe('com.acme.app.voip');
  });

  it('fails an empty device token without calling APNs', async () => {
    const { transport, calls } = mockTransport();
    const receipt = await createApnsAdapter({ ...baseConfig, transport }).send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'apns', channelUserId: '' },
    });

    expect(receipt.error?.code).toBe('apns_missing_device_token');
    expect(calls).toHaveLength(0);
  });
});

describe('error classification', () => {
  it('treats an uninstalled app as recipient-fatal and reports when it died', async () => {
    const { transport } = mockTransport([
      {
        status: 410,
        body: JSON.stringify({ reason: 'Unregistered', timestamp: 1_700_000_000_000 }),
      },
    ]);
    const receipt = await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.code).toBe('apns_Unregistered');
    expect(receipt.error?.permanent).toBe(true);
    expect(receipt.error?.retryable).toBe(false);
    expect(receipt.error?.message).toContain('2023-11-14T22:13:20.000Z');
  });

  it('does not blame the device for an expired provider token', async () => {
    const { transport } = mockTransport([
      { status: 403, body: JSON.stringify({ reason: 'ExpiredProviderToken' }) },
    ]);
    const receipt = await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.retryable).toBe(false);
    // Suppressing here would bin every device touched while a key was stale.
    expect(receipt.error?.permanent).toBeUndefined();
  });

  it('marks a throttle retryable and never suppressible', async () => {
    const { transport } = mockTransport([
      { status: 429, body: JSON.stringify({ reason: 'TooManyRequests' }) },
    ]);
    const receipt = await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.retryable).toBe(true);
    expect(receipt.error?.permanent).toBe(false);
  });

  it('leaves an unknown reason unclassified rather than guessing', () => {
    expect(classifyApnsReason('SomethingNew')).toEqual({});
    expect(classifyApnsReason(undefined)).toEqual({});
  });

  it('never marks a transport failure permanent', async () => {
    const transport: ApnsTransport = async () => {
      throw new Error('ECONNRESET');
    };
    const receipt = await createApnsAdapter({ ...baseConfig, transport }).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.code).toBe('apns_network_error');
    expect(receipt.error?.permanent).toBe(false);
  });
});

describe('sendRaw', () => {
  it('sends an arbitrary payload with overridden headers', async () => {
    const { transport, calls } = mockTransport();
    await createApnsAdapter({ ...baseConfig, transport }).sendRaw(
      'tok',
      { aps: { 'content-available': 1 } },
      { 'apns-push-type': 'background', 'apns-priority': '5' },
    );

    expect(calls[0]!.headers['apns-push-type']).toBe('background');
    expect(calls[0]!.headers['apns-priority']).toBe('5');
    expect(JSON.parse(calls[0]!.body)).toEqual({ aps: { 'content-available': 1 } });
  });
});

describe('verifyCredentials', () => {
  it('reads BadDeviceToken as proof the key itself is good', async () => {
    const { transport } = mockTransport([
      { status: 400, body: JSON.stringify({ reason: 'BadDeviceToken' }) },
    ]);
    const result = await createApnsAdapter({ ...baseConfig, transport }).verifyCredentials();

    expect(result.ok).toBe(true);
  });

  it('reports a rejected provider token as unauthorized', async () => {
    const { transport } = mockTransport([
      { status: 403, body: JSON.stringify({ reason: 'InvalidProviderToken' }) },
    ]);
    const result = await createApnsAdapter({ ...baseConfig, transport }).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('names the topic when Apple rejects it', async () => {
    const { transport } = mockTransport([
      { status: 400, body: JSON.stringify({ reason: 'TopicDisallowed' }) },
    ]);
    const result = await createApnsAdapter({ ...baseConfig, transport }).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('com.acme.app');
  });

  it('asks for the missing config before touching the network', async () => {
    const spy = vi.fn();
    const result = await createApnsAdapter({
      ...baseConfig,
      teamId: '',
      transport: spy,
    }).verifyCredentials();

    expect(result.ok).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });
});

describe('inbound', () => {
  it('returns nothing, because push is one-way', async () => {
    const { transport } = mockTransport();
    const adapter = createApnsAdapter({ ...baseConfig, transport });

    expect(
      await adapter.handleWebhook({ headers: {}, rawBody: new Uint8Array(), body: null, query: {} }),
    ).toEqual([]);
    expect(adapter.capabilities.interactive.buttons).toBe(false);
  });
});
