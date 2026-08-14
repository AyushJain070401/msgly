import { generateKeyPairSync, sign as nodeSign } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelnyxAdapter, mapTelnyxStatus } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  apiKey: 'KEY0123456789',
  from: '+15550001111',
  apiBase: 'https://api.test.local',
};

const account = { channel: 'telnyx' as const, channelAccountId: '+15550001111' };
const contact = { channel: 'telnyx' as const, channelUserId: '+15550002222' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Real Ed25519 keypair, so signature tests exercise actual crypto. */
const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicKeyB64 = publicKey
  .export({ type: 'spki', format: 'der' })
  .subarray(-32) // raw 32-byte key, which is what Telnyx publishes
  .toString('base64');

function signPayload(timestamp: string, body: string): string {
  return nodeSign(null, Buffer.from(`${timestamp}|${body}`), privateKey).toString('base64');
}

function mockApi(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(content: Parameters<ReturnType<typeof createTelnyxAdapter>['send']>[0]['content']) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'telnyx' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('createTelnyxAdapter', () => {
  it('declares the telnyx channel with MMS image support', () => {
    const a = createTelnyxAdapter(baseConfig);
    expect(a.channel).toBe('telnyx');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
  });

  it('sends a text message', async () => {
    const calls = mockApi({ data: { id: 'msg-1', to: [{ status: 'queued' }] } });

    const a = createTelnyxAdapter({ ...baseConfig, messagingProfileId: 'prof-1' });
    const receipt = await a.send(outbound({ type: 'text', text: 'hello' }));

    expect(receipt.status).toBe('queued');
    expect(receipt.externalId).toBe('msg-1');
    expect(calls[0]!.url).toBe('https://api.test.local/v2/messages');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer KEY0123456789');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({
      from: '+15550001111',
      to: '+15550002222',
      text: 'hello',
      messaging_profile_id: 'prof-1',
    });
  });

  it('sends an image as MMS media_urls', async () => {
    const calls = mockApi({ data: { id: 'msg-2', to: [{ status: 'queued' }] } });

    const a = createTelnyxAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.test/p.png' },
        caption: 'look',
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.media_urls).toEqual(['https://cdn.test/p.png']);
    expect(body.text).toBe('look');
  });

  it('refuses MMS with a platform-id ref', async () => {
    const calls = mockApi({ data: { id: 'x' } });
    const a = createTelnyxAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'platform-id', value: 'abc' } }),
    );

    expect(receipt.error?.code).toBe('telnyx_media_url_required');
    expect(calls).toHaveLength(0);
  });

  it('surfaces a Telnyx API error', async () => {
    mockApi(
      { errors: [{ code: '10015', detail: 'Invalid destination number' }] },
      422,
    );

    const a = createTelnyxAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('telnyx_10015');
    expect(receipt.error?.message).toBe('Invalid destination number');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const a = createTelnyxAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(receipt.error?.code).toBe('telnyx_network_error');
  });

  it('parses an inbound message.received event', async () => {
    const a = createTelnyxAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        data: {
          event_type: 'message.received',
          occurred_at: '2026-01-01T10:00:00.000Z',
          payload: {
            id: 'in-1',
            text: 'STOP',
            from: { phone_number: '+15550002222' },
            to: [{ phone_number: '+15550001111' }],
          },
        },
      },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('STOP');
    expect(m.contact.channelUserId).toBe('+15550002222');
    expect(m.externalId).toBe('in-1');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('parses inbound MMS as image content', async () => {
    const a = createTelnyxAdapter(baseConfig);
    const [m] = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        data: {
          event_type: 'message.received',
          payload: {
            id: 'in-2',
            text: 'pic',
            from: { phone_number: '+1555' },
            to: [{ phone_number: '+1556' }],
            media: [{ url: 'https://media.test/x.jpg', content_type: 'image/jpeg' }],
          },
        },
      },
    });

    expect(m!.content).toMatchObject({
      type: 'image',
      mediaRef: { kind: 'url', value: 'https://media.test/x.jpg', mimeType: 'image/jpeg' },
      caption: 'pic',
    });
  });

  it('ignores delivery events', async () => {
    const a = createTelnyxAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: { data: { event_type: 'message.finalized', payload: { id: 'x' } } },
    });
    expect(messages).toEqual([]);
  });

  it('verifies a real Ed25519 signature', async () => {
    const a = createTelnyxAdapter({ ...baseConfig, publicKey: publicKeyB64 });
    const body = JSON.stringify({ data: { event_type: 'message.received' } });
    const ts = String(Math.floor(Date.now() / 1000));

    expect(
      await a.verifySignature({
        headers: {
          'telnyx-signature-ed25519': signPayload(ts, body),
          'telnyx-timestamp': ts,
        },
        rawBody: encode(body),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const a = createTelnyxAdapter({ ...baseConfig, publicKey: publicKeyB64 });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signPayload(ts, '{"a":1}');

    expect(
      await a.verifySignature({
        headers: { 'telnyx-signature-ed25519': sig, 'telnyx-timestamp': ts },
        rawBody: encode('{"a":2}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp, bounding replay', async () => {
    const a = createTelnyxAdapter({ ...baseConfig, publicKey: publicKeyB64 });
    const body = '{}';
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);

    expect(
      await a.verifySignature({
        headers: {
          'telnyx-signature-ed25519': signPayload(staleTs, body),
          'telnyx-timestamp': staleTs,
        },
        rawBody: encode(body),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a request with signature headers missing', async () => {
    const a = createTelnyxAdapter({ ...baseConfig, publicKey: publicKeyB64 });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('skips verification when no public key is configured', async () => {
    const a = createTelnyxAdapter(baseConfig);
    expect(
      await a.verifySignature({ headers: {}, rawBody: encode('{}'), body: {}, query: {} }),
    ).toBe(true);
  });

  it('verifyCredentials succeeds on a healthy key', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: true, status: 200, json: async () => ({ data: [] }) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createTelnyxAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createTelnyxAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('verifyCredentials returns a hint when the key is missing', async () => {
    const result = await createTelnyxAdapter({ ...baseConfig, apiKey: '' }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('apiKey');
  });
});

describe('mapTelnyxStatus', () => {
  it('maps Telnyx states onto unified statuses', () => {
    expect(mapTelnyxStatus('queued')).toBe('queued');
    expect(mapTelnyxStatus('delivered')).toBe('delivered');
    expect(mapTelnyxStatus('delivery_failed')).toBe('failed');
    expect(mapTelnyxStatus('sending_failed')).toBe('failed');
  });
});
