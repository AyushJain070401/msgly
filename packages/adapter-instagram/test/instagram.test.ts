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
