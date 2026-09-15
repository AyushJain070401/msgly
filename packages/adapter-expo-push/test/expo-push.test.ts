import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyExpoError, createExpoPushAdapter, isExpoPushToken } from '../src/index.js';

const config = { defaultTitle: 'Acme', apiBase: 'https://expo.test.local' };

type Call = { url: string; init?: RequestInit };

function mockFetch(payload: unknown, status = 200) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { status, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const bodyOf = (calls: Call[], i = 0) => JSON.parse(calls[i]!.init!.body as string);

function outbound(content: unknown, metadata?: unknown) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'expo-push' as const,
    account: { channel: 'expo-push' as const, channelAccountId: 'acme' },
    contact: { channel: 'expo-push' as const, channelUserId: 'ExponentPushToken[abc]' },
    content,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  } as Parameters<ReturnType<typeof createExpoPushAdapter>['send']>[0];
}

describe('createExpoPushAdapter', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('recognises Expo token formats', () => {
    expect(isExpoPushToken('ExponentPushToken[xxx]')).toBe(true);
    expect(isExpoPushToken('ExpoPushToken[xxx]')).toBe(true);
    expect(isExpoPushToken('some-fcm-token')).toBe(false);
  });

  it('sends a notification as a one-element batch', async () => {
    const calls = mockFetch({ data: [{ status: 'ok', id: 'ticket-1' }] });
    const receipt = await createExpoPushAdapter(config).send(
      outbound({ type: 'text', text: 'your order shipped' }),
    );

    // A ticket means queued, not delivered — the receipt must not overclaim.
    expect(receipt.status).toBe('queued');
    expect(receipt.externalId).toBe('ticket-1');
    expect(receipt.recipientId).toBe('ExponentPushToken[abc]');

    expect(calls[0]!.url).toBe('https://expo.test.local/--/api/v2/push/send');
    expect(bodyOf(calls)).toEqual([
      {
        to: 'ExponentPushToken[abc]',
        title: 'Acme',
        body: 'your order shipped',
        sound: 'default',
      },
    ]);
  });

  it('sends the access token only when one is configured', async () => {
    let calls = mockFetch({ data: [{ status: 'ok', id: 't' }] });
    await createExpoPushAdapter(config).send(outbound({ type: 'text', text: 'hi' }));
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBeUndefined();

    calls = mockFetch({ data: [{ status: 'ok', id: 't' }] });
    await createExpoPushAdapter({ ...config, accessToken: 'tok' }).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe('Bearer tok');
  });

  it('carries data, badge, ttl and the Android channel', async () => {
    const calls = mockFetch({ data: [{ status: 'ok', id: 't' }] });
    await createExpoPushAdapter({ ...config, defaultChannelId: 'default' }).send(
      outbound({ type: 'text', text: 'hi' }, { data: { orderId: '42' }, badge: 3, ttl: 60 }),
    );

    expect(bodyOf(calls)[0]).toMatchObject({
      channelId: 'default',
      data: { orderId: '42' },
      badge: 3,
      ttl: 60,
    });
  });

  it('attaches an image as richContent', async () => {
    const calls = mockFetch({ data: [{ status: 'ok', id: 't' }] });
    await createExpoPushAdapter(config).send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.example.com/a.png' },
        caption: 'look',
      }),
    );

    expect(bodyOf(calls)[0]).toMatchObject({
      body: 'look',
      richContent: { image: 'https://cdn.example.com/a.png' },
    });
  });

  it('treats a dead token as recipient-fatal', async () => {
    mockFetch({
      data: [
        {
          status: 'error',
          message: '"ExponentPushToken[abc]" is not a registered push notification recipient',
          details: { error: 'DeviceNotRegistered' },
        },
      ],
    });
    const receipt = await createExpoPushAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.code).toBe('expo_DeviceNotRegistered');
    expect(receipt.error?.permanent).toBe(true);
    expect(receipt.error?.retryable).toBe(false);
  });

  it('does not blame the device for bad credentials', async () => {
    mockFetch({
      data: [{ status: 'error', message: 'bad creds', details: { error: 'InvalidCredentials' } }],
    });
    const receipt = await createExpoPushAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.retryable).toBe(false);
    expect(receipt.error?.permanent).toBeUndefined();
  });

  it('marks a rate limit transient', async () => {
    mockFetch({
      data: [{ status: 'error', message: 'slow down', details: { error: 'MessageRateExceeded' } }],
    });
    const receipt = await createExpoPushAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.retryable).toBe(true);
    expect(receipt.error?.permanent).toBe(false);
  });

  it('surfaces a request-level error', async () => {
    mockFetch({ errors: [{ message: 'Unauthorized', code: 'UNAUTHORIZED' }] }, 401);
    const receipt = await createExpoPushAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('expo_401');
  });

  it('never marks a network failure permanent', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const receipt = await createExpoPushAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.code).toBe('expo_network_error');
    expect(receipt.error?.permanent).toBe(false);
  });

  it('refuses an empty token without calling Expo', async () => {
    const calls = mockFetch({ data: [] });
    const receipt = await createExpoPushAdapter(config).send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'expo-push', channelUserId: '' },
    });

    expect(receipt.error?.code).toBe('expo_missing_token');
    expect(calls).toHaveLength(0);
  });
});

describe('sendMulticast', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('maps tickets back to tokens by position', async () => {
    const calls = mockFetch({
      data: [
        { status: 'ok', id: 't1' },
        { status: 'error', message: 'gone', details: { error: 'DeviceNotRegistered' } },
      ],
    });

    const receipts = await createExpoPushAdapter(config).sendMulticast(
      ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
      { body: 'hello' },
    );

    expect(bodyOf(calls)).toHaveLength(2);
    expect(receipts[0]!.status).toBe('queued');
    expect(receipts[0]!.recipientId).toBe('ExponentPushToken[a]');
    expect(receipts[1]!.error?.permanent).toBe(true);
    expect(receipts[1]!.recipientId).toBe('ExponentPushToken[b]');
  });

  it('does not shift results when Expo returns a short array', async () => {
    mockFetch({ data: [{ status: 'ok', id: 't1' }] });

    const receipts = await createExpoPushAdapter(config).sendMulticast(
      ['ExponentPushToken[a]', 'ExponentPushToken[b]'],
      { body: 'hello' },
    );

    expect(receipts[1]!.error?.code).toBe('expo_no_ticket');
    expect(receipts[1]!.recipientId).toBe('ExponentPushToken[b]');
  });

  it('returns nothing for an empty token list, without calling Expo', async () => {
    const calls = mockFetch({ data: [] });
    expect(await createExpoPushAdapter(config).sendMulticast([], { body: 'x' })).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('getReceipts', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('turns a receipt lookup into delivery receipts', async () => {
    const calls = mockFetch({
      data: {
        't1': { status: 'ok' },
        't2': {
          status: 'error',
          message: 'not registered',
          details: { error: 'DeviceNotRegistered' },
        },
      },
    });

    const receipts = await createExpoPushAdapter(config).getReceipts(['t1', 't2']);

    expect(calls[0]!.url).toContain('/--/api/v2/push/getReceipts');
    expect(bodyOf(calls)).toEqual({ ids: ['t1', 't2'] });

    expect(receipts[0]).toMatchObject({ messageId: 't1', status: 'delivered' });
    expect(receipts[1]).toMatchObject({ messageId: 't2', status: 'failed' });
    // This is the only place a dead Expo token ever surfaces.
    expect(receipts[1]!.error?.permanent).toBe(true);
  });

  it('returns nothing for an empty id list', async () => {
    const calls = mockFetch({ data: {} });
    expect(await createExpoPushAdapter(config).getReceipts([])).toEqual([]);
    expect(calls).toHaveLength(0);
  });
});

describe('classification', () => {
  it('leaves an unknown error unclassified rather than guessing', () => {
    expect(classifyExpoError('SomethingNew')).toEqual({});
    expect(classifyExpoError(undefined)).toEqual({});
  });
});

describe('inbound', () => {
  it('returns nothing, because push is one-way', async () => {
    const adapter = createExpoPushAdapter(config);
    expect(
      await adapter.handleWebhook({ headers: {}, rawBody: new Uint8Array(), body: null, query: {} }),
    ).toEqual([]);
  });
});
