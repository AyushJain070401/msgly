import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildSignaturePayload,
  createVonageSmsAdapter,
  mapVonageStatus,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  apiKey: 'key-abc',
  apiSecret: 'secret-xyz',
  from: 'ACMECO',
  apiBase: 'https://rest.test.local',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Independent signature computation, so this checks the adapter's logic. */
function signParams(secret: string, params: Record<string, string>): string {
  return createHmac('sha256', secret)
    .update(buildSignaturePayload(params))
    .digest('hex')
    .toUpperCase();
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    rawBody: encode(''),
    body: {},
    query: {},
    ...overrides,
  } as Parameters<ReturnType<typeof createVonageSmsAdapter>['handleWebhook']>[0];
}

function mockSend(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

describe('createVonageSmsAdapter', () => {
  it('declares the vonage-sms channel and text-only capabilities', () => {
    const a = createVonageSmsAdapter(baseConfig);
    expect(a.channel).toBe('vonage-sms');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(false);
  });

  it('sends an SMS and returns the message id', async () => {
    const calls = mockSend({
      'message-count': '1',
      messages: [{ 'message-id': '0A0000001234', status: '0' }],
    });

    const a = createVonageSmsAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'vonage-sms',
      account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
      contact: { channel: 'vonage-sms', channelUserId: '447700900000' },
      content: { type: 'text', text: 'hello' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('0A0000001234');
    expect(calls[0]!.url).toBe('https://rest.test.local/sms/json');

    const form = new URLSearchParams(calls[0]!.init!.body as string);
    expect(form.get('api_key')).toBe('key-abc');
    expect(form.get('from')).toBe('ACMECO');
    expect(form.get('to')).toBe('447700900000');
    expect(form.get('text')).toBe('hello');
    expect(form.get('type')).toBe('text');
  });

  it('switches to the unicode type for non-GSM-7 text', async () => {
    const calls = mockSend({ messages: [{ 'message-id': 'x', status: '0' }] });

    const a = createVonageSmsAdapter(baseConfig);
    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'vonage-sms',
      account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
      contact: { channel: 'vonage-sms', channelUserId: '447700900000' },
      content: { type: 'text', text: 'नमस्ते 🎉' },
      timestamp: new Date().toISOString(),
    });

    expect(new URLSearchParams(calls[0]!.init!.body as string).get('type')).toBe('unicode');
  });

  it('treats a non-zero status as failure even though HTTP is 200', async () => {
    // Vonage returns 200 OK for rejected messages — trusting the HTTP status
    // would silently report undelivered messages as sent.
    mockSend({ messages: [{ status: '15', 'error-text': 'Invalid Sender Address' }] }, 200);

    const a = createVonageSmsAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'vonage-sms',
      account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
      contact: { channel: 'vonage-sms', channelUserId: '12025550100' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('vonage_15');
    expect(receipt.error?.message).toBe('Invalid Sender Address');
  });

  it('explains a status code even when Vonage sends no error text', async () => {
    mockSend({ messages: [{ status: '29' }] }, 200);

    const a = createVonageSmsAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'vonage-sms',
      account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
      contact: { channel: 'vonage-sms', channelUserId: '447700900000' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.error?.message).toContain('Non-whitelisted destination');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ETIMEDOUT');
    }) as unknown as typeof fetch;

    const a = createVonageSmsAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'vonage-sms',
      account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
      contact: { channel: 'vonage-sms', channelUserId: '447700900000' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('vonage_network_error');
  });

  it('rejects non-text content', async () => {
    const a = createVonageSmsAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'vonage-sms',
      account: { channel: 'vonage-sms', channelAccountId: 'ACMECO' },
      contact: { channel: 'vonage-sms', channelUserId: '447700900000' },
      content: { type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('vonage_unsupported_content');
  });

  it('parses an inbound SMS delivered as query parameters', async () => {
    const a = createVonageSmsAdapter(baseConfig);
    const messages = await a.handleWebhook(
      req({
        query: {
          msisdn: '447700900001',
          to: 'ACMECO',
          messageId: 'msg-in-1',
          text: 'HELP',
          keyword: 'HELP',
          'message-timestamp': '2026-01-01 10:00:00',
        },
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('vonage-sms');
    expect(m.externalId).toBe('msg-in-1');
    expect((m.content as { text: string }).text).toBe('HELP');
    expect(m.contact.channelUserId).toBe('447700900001');
    expect(m.metadata?.keyword).toBe('HELP');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('ignores delivery receipts, which carry a status and no text', async () => {
    const a = createVonageSmsAdapter(baseConfig);
    const messages = await a.handleWebhook(
      req({
        body: { msisdn: '447700900001', messageId: 'msg-1', status: 'delivered' },
      }),
    );
    expect(messages).toEqual([]);
  });

  it('accepts any webhook when no signature secret is configured', async () => {
    const a = createVonageSmsAdapter(baseConfig);
    expect(await a.verifySignature(req({ query: { messageId: 'x' } }))).toBe(true);
  });

  it('verifies a correctly signed webhook and rejects a tampered one', async () => {
    const a = createVonageSmsAdapter({ ...baseConfig, signatureSecret: 'sig-secret' });
    const params = {
      msisdn: '447700900001',
      to: 'ACMECO',
      messageId: 'msg-in-1',
      text: 'HELP',
    };
    const sig = signParams('sig-secret', params);

    expect(await a.verifySignature(req({ query: { ...params, sig } }))).toBe(true);

    // Same signature, altered body — must fail.
    expect(
      await a.verifySignature(req({ query: { ...params, text: 'TAMPERED', sig } })),
    ).toBe(false);

    // Missing signature entirely.
    expect(await a.verifySignature(req({ query: params }))).toBe(false);
  });

  it('refuses the legacy md5hash scheme with an actionable error', async () => {
    const a = createVonageSmsAdapter({
      ...baseConfig,
      signatureSecret: 's',
      signatureMethod: 'md5hash' as const,
    });
    await expect(a.verifySignature(req({ query: { sig: 'x' } }))).rejects.toThrow(
      'SHA-256 signed webhooks',
    );
  });

  it('verifyCredentials reports the account balance on success', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: true, status: 200, json: async () => ({ value: 12.5 }) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createVonageSmsAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('12.50');
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createVonageSmsAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('verifyCredentials returns a hint when the secret is missing', async () => {
    const result = await createVonageSmsAdapter({
      ...baseConfig,
      apiSecret: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('apiSecret');
  });
});

describe('buildSignaturePayload', () => {
  it('sorts keys, skips sig, and escapes & and = in values', () => {
    expect(
      buildSignaturePayload({ b: '2', a: '1', sig: 'ignored', c: 'x&y=z' }),
    ).toBe('&a=1&b=2&c=x_y_z');
  });
});

describe('mapVonageStatus', () => {
  it('treats only "0" as success', () => {
    expect(mapVonageStatus('0')).toBe('sent');
    expect(mapVonageStatus('1')).toBe('failed');
    expect(mapVonageStatus(undefined)).toBe('failed');
  });
});
