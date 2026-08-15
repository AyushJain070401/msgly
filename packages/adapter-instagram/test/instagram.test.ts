import { afterEach, describe, expect, it, vi } from 'vitest';

import { createInstagramAdapter } from '../src/index.js';

const config = {
  pageAccessToken: 'ig-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
};

const encode = (s: string) => new TextEncoder().encode(s);

describe('createInstagramAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createInstagramAdapter(config);
    expect(a.channel).toBe('instagram');
    expect(a.capabilities.media.audio).toBe(false);
    expect(a.capabilities.media.file).toBe(false);
    expect(a.capabilities.templates).toBe(false);
  });

  it('parses an inbound text message', async () => {
    const a = createInstagramAdapter(config);
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig-account',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user-ig' },
              recipient: { id: 'ig-account' },
              timestamp: 1700000000000,
              message: { mid: 'mid.ig.1', text: 'hello from ig' },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channel).toBe('instagram');
  });

  it('verifyCredentials gives an Instagram-specific hint when token missing', async () => {
    const a = createInstagramAdapter({
      pageAccessToken: '',
      appSecret: 'x',
      verifyToken: 'y',
    });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Instagram');
  });
});

describe('publishPost', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockGraph(container: unknown, publish: unknown, ok = true) {
    const calls: Array<{ url: string; body: string }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, body: (init?.body as string) ?? '' });
      const isPublish = url.includes('media_publish');
      return {
        ok,
        status: ok ? 200 : 400,
        json: async () => (isPublish ? publish : container),
      } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it('creates a container then publishes it', async () => {
    const calls = mockGraph({ id: 'container-1' }, { id: 'media-9' });
    const a = createInstagramAdapter({ ...config, igUserId: 'ig-123' });

    const result = await a.publishPost({
      imageUrl: 'https://cdn.acme.com/promo.jpg',
      caption: 'Diwali sale 🪔',
    });

    expect(result).toEqual({ id: 'media-9', containerId: 'container-1' });
    // Instagram's publishing flow is deliberately two-step.
    expect(calls).toHaveLength(2);
    expect(calls[0]!.url).toContain('/ig-123/media');
    expect(calls[0]!.body).toContain('image_url=https%3A%2F%2Fcdn.acme.com%2Fpromo.jpg');
    expect(calls[1]!.url).toContain('/ig-123/media_publish');
    expect(calls[1]!.body).toContain('creation_id=container-1');
  });

  it('marks a video container as a Reel when asked', async () => {
    const calls = mockGraph({ id: 'c-1' }, { id: 'm-1' });
    const a = createInstagramAdapter({ ...config, igUserId: 'ig-123' });
    await a.publishPost({ videoUrl: 'https://cdn.acme.com/v.mp4', isReel: true });

    expect(calls[0]!.body).toContain('media_type=REELS');
  });

  it('explains that the media URL must be publicly reachable', async () => {
    mockGraph({ error: { message: 'The media could not be fetched' } }, {}, false);
    const a = createInstagramAdapter({ ...config, igUserId: 'ig-123' });

    await expect(a.publishPost({ imageUrl: 'http://localhost/x.jpg' })).rejects.toThrow(
      'publicly reachable',
    );
  });

  it('requires an IG user id, and says it is not the Page id', async () => {
    const a = createInstagramAdapter(config);
    await expect(a.publishPost({ imageUrl: 'https://x/y.jpg' })).rejects.toThrow(
      'not the Facebook Page id',
    );
  });

  it('requires some media', async () => {
    const a = createInstagramAdapter({ ...config, igUserId: 'ig-123' });
    await expect(a.publishPost({ caption: 'text only' })).rejects.toThrow(
      'imageUrl or videoUrl',
    );
  });
});

// ---------------------------------------------------------------------------
// send(), signature verification and the OAuth helpers — previously untested.
// ---------------------------------------------------------------------------

describe('send and webhook security', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockSend(payload: unknown = { message_id: 'mid.123' }, status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  function outbound(content: Parameters<ReturnType<typeof createInstagramAdapter>['send']>[0]['content']) {
    return {
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'instagram' as const,
      account: { channel: 'instagram' as const, channelAccountId: 'ig-acct' },
      contact: { channel: 'instagram' as const, channelUserId: 'user-1' },
      content,
      timestamp: new Date().toISOString(),
    };
  }

  it('sends text through the Send API', async () => {
    const calls = mockSend();
    const receipt = await createInstagramAdapter(config).send(
      outbound({ type: 'text', text: 'hello' }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('mid.123');
    expect(calls[0]!.url).toContain('/me/messages');
    // The token rides in the query string, so it must be URL-encoded.
    expect(calls[0]!.url).toContain('access_token=ig-token');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.recipient).toEqual({ id: 'user-1' });
    expect(body.message).toEqual({ text: 'hello' });
  });

  it('surfaces a Meta error code', async () => {
    mockSend({ error: { code: 10, message: 'outside 24h window' } }, 400);
    const receipt = await createInstagramAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('meta_10');
    expect(receipt.error?.message).toContain('24h');
  });

  it('fails on a 200 that carries no message id', async () => {
    mockSend({}, 200);
    const receipt = await createInstagramAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.status).toBe('failed');
  });

  it('verifies a genuine X-Hub-Signature-256 and rejects a tampered body', async () => {
    const a = createInstagramAdapter(config);
    const body = encode('{"object":"instagram"}');

    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.appSecret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const buf = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
    const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buf));
    const hex = [...sig].map((b) => b.toString(16).padStart(2, '0')).join('');

    expect(
      await a.verifySignature({
        headers: { 'x-hub-signature-256': `sha256=${hex}` },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);

    expect(
      await a.verifySignature({
        headers: { 'x-hub-signature-256': `sha256=${hex}` },
        rawBody: encode('{"object":"tampered"}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a signature header with no sha256= prefix', async () => {
    const a = createInstagramAdapter(config);
    expect(
      await a.verifySignature({
        headers: { 'x-hub-signature-256': 'deadbeef' },
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('answers the Meta GET verification challenge only with the right token', async () => {
    const a = createInstagramAdapter(config);
    expect(
      a.verifyWebhookChallenge?.({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'nonce-1',
      }),
    ).toBe('nonce-1');

    expect(
      a.verifyWebhookChallenge?.({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'wrong',
        'hub.challenge': 'nonce-1',
      }),
    ).toBeNull();
  });

  it('ignores echo messages, which would otherwise loop', async () => {
    const a = createInstagramAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        object: 'instagram',
        entry: [
          {
            id: 'ig-acct',
            messaging: [
              {
                sender: { id: 'ig-acct' },
                recipient: { id: 'user-1' },
                timestamp: 1767261600000,
                message: { mid: 'mid.echo', text: 'sent by us', is_echo: true },
              },
            ],
          },
        ],
      },
    });
    expect(messages).toEqual([]);
  });
});

describe('Instagram Login OAuth helpers', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('builds an authorization URL with scopes and state', () => {
    const url = new URL(
      createInstagramAdapter(config).getAuthUrl({
        appId: 'app-1',
        redirectUri: 'https://acme.com/cb',
        state: 'xyz',
      }),
    );

    expect(url.searchParams.get('client_id')).toBe('app-1');
    expect(url.searchParams.get('redirect_uri')).toBe('https://acme.com/cb');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('state')).toBe('xyz');
    expect(url.searchParams.get('scope')).toBeTruthy();
  });

  it('exchanges a code for a token', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'short-lived', token_type: 'bearer' }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createInstagramAdapter(config).exchangeCode('code-1', {
      appId: 'app-1',
      appSecret: 'secret',
      redirectUri: 'https://acme.com/cb',
    });
    expect(result.accessToken).toBe('short-lived');
  });

  it('throws with Meta’s message when the exchange fails', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({ error_message: 'This authorization code has expired' }),
        }) as Response,
    ) as unknown as typeof fetch;

    await expect(
      createInstagramAdapter(config).exchangeCode('stale', {
        appId: 'a',
        appSecret: 's',
        redirectUri: 'r',
      }),
    ).rejects.toThrow('expired');
  });

  it('requires an app secret for the long-lived exchange', async () => {
    const a = createInstagramAdapter({ ...config, appSecret: '' });
    await expect(a.getLongLivedToken('short')).rejects.toThrow('appSecret is required');
  });
});
