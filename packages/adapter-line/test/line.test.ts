import { afterEach, describe, expect, it, vi } from 'vitest';

import { createLineAdapter } from '../src/index.js';

const config = {
  channelAccessToken: 'test-token',
  channelSecret: 'test-secret',
};

const encode = (s: string) => new TextEncoder().encode(s);

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

async function signLine(body: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buffer));
  let binary = '';
  for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]!);
  return btoa(binary);
}

describe('createLineAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createLineAdapter(config);
    expect(a.channel).toBe('line');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(false);
  });

  it('verifies a valid signature', async () => {
    const a = createLineAdapter(config);
    const body = encode('{"events":[]}');
    const sig = await signLine(body);
    expect(
      await a.verifySignature({
        headers: { 'x-line-signature': sig },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const a = createLineAdapter(config);
    expect(
      await a.verifySignature({
        headers: { 'x-line-signature': 'wrongsig' },
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('parses an inbound text message and captures replyToken', async () => {
    const a = createLineAdapter(config);
    const event = {
      events: [
        {
          type: 'message',
          timestamp: 1700000000000,
          replyToken: 'rt-123',
          source: { type: 'user', userId: 'U-abc' },
          message: { id: 'msg-1', type: 'text', text: 'hello there' },
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: event,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.content.type).toBe('text');
    expect((m.content as { text: string }).text).toBe('hello there');
    expect(m.metadata?.replyToken).toBe('rt-123');
    expect(m.contact.channelUserId).toBe('U-abc');
  });

  it('parses an inbound file message even though LINE cannot send files', async () => {
    const a = createLineAdapter(config);
    // Sending files is not a LINE capability, but users can send them to a bot.
    expect(a.capabilities.media.file).toBe(false);

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {
        events: [
          {
            type: 'message',
            timestamp: 1700000000000,
            replyToken: 'rt-9',
            source: { type: 'user', userId: 'U-abc' },
            message: {
              id: 'msg-file-1',
              type: 'file',
              fileName: 'contract.pdf',
              fileSize: 12345,
            },
          },
        ],
      },
      query: {},
    });

    expect(messages).toHaveLength(1);
    const content = messages[0]!.content as {
      type: string;
      mediaRef: { value: string; filename?: string };
    };
    expect(content.type).toBe('file');
    expect(content.mediaRef.value).toBe('msg-file-1');
    expect(content.mediaRef.filename).toBe('contract.pdf');
  });

  it('skips non-message events', async () => {
    const a = createLineAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { events: [{ type: 'follow', timestamp: 0, source: {} }] },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('verifyCredentials returns actionable hint when token is empty', async () => {
    const a = createLineAdapter({ channelAccessToken: '', channelSecret: 'x' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('LINE Developers Console');
    }
  });

  it('verifyCredentials returns actionable hint when secret is empty', async () => {
    const a = createLineAdapter({ channelAccessToken: 'x', channelSecret: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Channel secret');
  });
});

describe('broadcast and multicast', () => {
  function mockPost(status = 200, payload: unknown = {}) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it('broadcasts to every friend in one call', async () => {
    const calls = mockPost();
    const a = createLineAdapter(config);
    const receipt = await a.broadcast({ type: 'text', text: 'Sale is live' });

    expect(receipt.status).toBe('sent');
    expect(calls[0]!.url).toContain('/v2/bot/message/broadcast');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.messages).toEqual([{ type: 'text', text: 'Sale is live' }]);
    // No recipient list at all — that is the point of broadcast.
    expect(body.to).toBeUndefined();
  });

  it('passes a retry key so a timeout cannot double-send a campaign', async () => {
    const calls = mockPost();
    const a = createLineAdapter(config);
    await a.broadcast({ type: 'text', text: 'x' }, { retryKey: 'campaign-42' });

    expect((calls[0]!.init!.headers as Record<string, string>)['X-Line-Retry-Key']).toBe(
      'campaign-42',
    );
  });

  it('multicasts to a segment', async () => {
    const calls = mockPost();
    const a = createLineAdapter(config);
    const receipt = await a.multicast(['U1', 'U2'], { type: 'text', text: 'hi' });

    expect(receipt.status).toBe('sent');
    expect(calls[0]!.url).toContain('/v2/bot/message/multicast');
    expect(JSON.parse(calls[0]!.init!.body as string).to).toEqual(['U1', 'U2']);
  });

  it('refuses a multicast over LINE’s 500-recipient limit', async () => {
    const calls = mockPost();
    const a = createLineAdapter(config);
    const receipt = await a.multicast(
      Array.from({ length: 501 }, (_, i) => `U${i}`),
      { type: 'text', text: 'x' },
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('line_multicast_limit');
    expect(receipt.error?.permanent).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty multicast', async () => {
    const a = createLineAdapter(config);
    const receipt = await a.multicast([], { type: 'text', text: 'x' });
    expect(receipt.error?.code).toBe('line_no_recipients');
  });

  it('treats a quota 429 as retryable but a 400 as permanent', async () => {
    mockPost(429, { message: 'monthly limit exceeded' });
    const quota = await createLineAdapter(config).broadcast({ type: 'text', text: 'x' });
    expect(quota.error?.permanent).toBe(false);

    mockPost(400, { message: 'invalid message' });
    const bad = await createLineAdapter(config).broadcast({ type: 'text', text: 'x' });
    expect(bad.error?.permanent).toBe(true);
  });

  it('reports remaining quota, and null on an unlimited plan', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () =>
        url.includes('consumption') ? { totalUsage: 300 } : { type: 'limited', value: 1000 },
    })) as unknown as typeof fetch;
    expect(await createLineAdapter(config).getQuotaRemaining()).toBe(700);

    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => ({
      ok: true,
      status: 200,
      json: async () => (url.includes('consumption') ? { totalUsage: 0 } : { type: 'none' }),
    })) as unknown as typeof fetch;
    expect(await createLineAdapter(config).getQuotaRemaining()).toBeNull();
  });
});
