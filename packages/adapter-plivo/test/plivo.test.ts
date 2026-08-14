import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computePlivoV3Signature, createPlivoAdapter, mapPlivoStatus } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const WEBHOOK_URL = 'https://example.com/webhook/plivo';

const baseConfig = {
  authId: 'MA1234567890',
  authToken: 'token-secret',
  src: '+15550001111',
  apiBase: 'https://api.test.local',
};

const account = { channel: 'plivo' as const, channelAccountId: '+15550001111' };
const contact = { channel: 'plivo' as const, channelUserId: '+15550002222' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Independent signature, so this validates the adapter rather than echoing it. */
function signV3(token: string, url: string, nonce: string): string {
  return createHmac('sha256', token).update(url + nonce).digest('base64');
}

function mockApi(payload: unknown, status = 202) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(content: Parameters<ReturnType<typeof createPlivoAdapter>['send']>[0]['content']) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'plivo' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
  };
}

describe('createPlivoAdapter', () => {
  it('declares the plivo channel with MMS image support', () => {
    const a = createPlivoAdapter(baseConfig);
    expect(a.channel).toBe('plivo');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
    expect(a.capabilities.media.file).toBe(false);
  });

  it('sends a text message and returns the message uuid', async () => {
    const calls = mockApi({ message: 'message(s) queued', message_uuid: ['uuid-1'] }, 202);

    const a = createPlivoAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hello' }));

    expect(receipt.status).toBe('queued');
    expect(receipt.externalId).toBe('uuid-1');
    expect(calls[0]!.url).toBe('https://api.test.local/v1/Account/MA1234567890/Message/');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa('MA1234567890:token-secret')}`);

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({
      src: '+15550001111',
      dst: '+15550002222',
      text: 'hello',
    });
  });

  it('sends an image as MMS with media_urls', async () => {
    const calls = mockApi({ message_uuid: ['uuid-2'] }, 202);

    const a = createPlivoAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.test/pic.png' },
        caption: 'look',
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.type).toBe('mms');
    expect(body.media_urls).toEqual(['https://cdn.test/pic.png']);
    expect(body.text).toBe('look');
  });

  it('refuses MMS with a platform-id ref, which Plivo cannot fetch', async () => {
    const calls = mockApi({ message_uuid: ['x'] });

    const a = createPlivoAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'platform-id', value: 'abc' } }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('plivo_media_url_required');
    expect(calls).toHaveLength(0);
  });

  it('includes the status callback url when configured', async () => {
    const calls = mockApi({ message_uuid: ['x'] });

    const a = createPlivoAdapter({
      ...baseConfig,
      statusCallbackUrl: 'https://example.com/status',
    });
    await a.send(outbound({ type: 'text', text: 'hi' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.url).toBe('https://example.com/status');
    expect(body.method).toBe('POST');
  });

  it('surfaces an API error as a failed receipt', async () => {
    mockApi({ error: 'invalid destination number' }, 400);

    const a = createPlivoAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('plivo_400');
    expect(receipt.error?.message).toBe('invalid destination number');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const a = createPlivoAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('plivo_network_error');
  });

  it('rejects unsupported content', async () => {
    const a = createPlivoAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'location', latitude: 1, longitude: 2 }),
    );
    expect(receipt.error?.code).toBe('plivo_unsupported_content');
  });

  it('parses an inbound SMS', async () => {
    const a = createPlivoAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {
        From: '+15550002222',
        To: '+15550001111',
        Text: 'STOP',
        MessageUUID: 'uuid-in-1',
        Type: 'sms',
      },
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('plivo');
    expect((m.content as { text: string }).text).toBe('STOP');
    expect(m.contact.channelUserId).toBe('+15550002222');
    expect(m.externalId).toBe('uuid-in-1');
  });

  it('ignores delivery callbacks, which carry a Status and no Text', async () => {
    const a = createPlivoAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { From: '+1555', MessageUUID: 'u-1', Status: 'delivered' },
      query: {},
    });
    expect(messages).toEqual([]);
  });

  it('verifies a valid V3 signature and rejects a bad one', async () => {
    const a = createPlivoAdapter({ ...baseConfig, webhookUrl: WEBHOOK_URL });
    const nonce = '12345';
    const sig = signV3(baseConfig.authToken, WEBHOOK_URL, nonce);

    const make = (signature: string, n = nonce) => ({
      headers: {
        'x-plivo-signature-v3': signature,
        'x-plivo-signature-v3-nonce': n,
      },
      rawBody: encode(''),
      body: {},
      query: {},
    });

    expect(await a.verifySignature(make(sig))).toBe(true);
    expect(await a.verifySignature(make('bogus'))).toBe(false);
    // Right signature, different nonce — must fail.
    expect(await a.verifySignature(make(sig, '99999'))).toBe(false);
  });

  it('accepts any of several comma-separated signatures during key rotation', async () => {
    const a = createPlivoAdapter({ ...baseConfig, webhookUrl: WEBHOOK_URL });
    const nonce = 'abc';
    const valid = signV3(baseConfig.authToken, WEBHOOK_URL, nonce);

    expect(
      await a.verifySignature({
        headers: {
          'x-plivo-signature-v3': `othersig,${valid}`,
          'x-plivo-signature-v3-nonce': nonce,
        },
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects a request with signature headers missing', async () => {
    const a = createPlivoAdapter({ ...baseConfig, webhookUrl: WEBHOOK_URL });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('skips verification when no webhookUrl is configured', async () => {
    const a = createPlivoAdapter(baseConfig);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('computePlivoV3Signature matches an independent HMAC', async () => {
    const mine = await computePlivoV3Signature('tok', 'https://x/y', 'n1');
    expect(mine).toBe(signV3('tok', 'https://x/y', 'n1'));
  });

  it('verifyCredentials reports the account name', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ name: 'Acme Inc', cash_credits: '10.5' }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createPlivoAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('Acme Inc');
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createPlivoAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('verifyCredentials explains the auth id format on 404', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createPlivoAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.hint).toContain('MA');
    }
  });
});

describe('mapPlivoStatus', () => {
  it('maps Plivo states onto unified statuses', () => {
    expect(mapPlivoStatus('queued')).toBe('queued');
    expect(mapPlivoStatus('delivered')).toBe('delivered');
    expect(mapPlivoStatus('undelivered')).toBe('failed');
    expect(mapPlivoStatus('rejected')).toBe('failed');
  });
});
