import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTikTokAdapter, tiktokErrorOf } from '../src/index.js';

const config = {
  clientKey: 'ckey',
  clientSecret: 'csecret',
  accessToken: 'tok-1',
  openId: 'open-1',
  apiBase: 'https://open.test.local',
};

const dmConfig = {
  ...config,
  directMessages: {
    baseUrl: 'https://dm.test.local',
    listPath: '/messages/list',
  },
};

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockApi(responder: (url: string) => unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => responder(url) } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const bodyOf = (init?: RequestInit) => JSON.parse((init?.body as string) ?? '{}');
const ok = (data: unknown) => ({ data, error: { code: 'ok', message: '' } });

function outbound(text: string, metadata?: Record<string, unknown>, channelUserId = '') {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'tiktok' as const,
    account: { channel: 'tiktok' as const, channelAccountId: 'open-1' },
    contact: { channel: 'tiktok' as const, channelUserId },
    content: { type: 'text' as const, text },
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

describe('createTikTokAdapter', () => {
  it('declares send() as text-only — publishing is not a send() capability', () => {
    const a = createTikTokAdapter(config);
    expect(a.channel).toBe('tiktok');
    expect(a.capabilities.text).toBe(true);
    // Comments and DMs carry no media. Claiming otherwise would make the hub
    // wave a video message through to a send() that must reject it.
    expect(a.capabilities.media).toEqual({
      image: false,
      video: false,
      audio: false,
      file: false,
    });
  });

  describe('publishVideo', () => {
    it('direct-posts a pulled URL with the post_info TikTok requires', async () => {
      const calls = mockApi(() => ok({ publish_id: 'pub-1' }));
      const result = await createTikTokAdapter(config).publishVideo({
        videoUrl: 'https://cdn.example.com/a.mp4',
        title: 'launch day',
        privacyLevel: 'PUBLIC_TO_EVERYONE',
      });

      expect(result.publishId).toBe('pub-1');
      expect(calls[0]!.url).toContain('/v2/post/publish/video/init/');
      const body = bodyOf(calls[0]!.init);
      expect(body.source_info).toEqual({
        source: 'PULL_FROM_URL',
        video_url: 'https://cdn.example.com/a.mp4',
      });
      expect(body.post_info.title).toBe('launch day');
      expect(body.post_info.privacy_level).toBe('PUBLIC_TO_EVERYONE');
    });

    it('defaults to SELF_ONLY, which is the safe level for an unaudited app', async () => {
      const calls = mockApi(() => ok({ publish_id: 'pub-1' }));
      await createTikTokAdapter(config).publishVideo({ videoUrl: 'https://cdn.example.com/a.mp4' });
      expect(bodyOf(calls[0]!.init).post_info.privacy_level).toBe('SELF_ONLY');
    });

    it('uses the inbox endpoint and omits post_info in INBOX mode', async () => {
      const calls = mockApi(() => ok({ publish_id: 'pub-2' }));
      await createTikTokAdapter({ ...config, postMode: 'INBOX' }).publishVideo({
        videoUrl: 'https://cdn.example.com/a.mp4',
        title: 'ignored — the creator captions it in-app',
      });
      expect(calls[0]!.url).toContain('/v2/post/publish/inbox/video/init/');
      expect(bodyOf(calls[0]!.init).post_info).toBeUndefined();
    });

    it('uploads bytes to the returned upload_url as a single chunk', async () => {
      const calls = mockApi((url) =>
        url.includes('/init/') ? ok({ publish_id: 'pub-3', upload_url: 'https://up.test.local/x' }) : {},
      );
      const data = new Uint8Array(2048);
      await createTikTokAdapter(config).publishVideo({
        videoFile: { data, mimeType: 'video/mp4' },
      });

      const init = bodyOf(calls[0]!.init).source_info;
      expect(init).toEqual({
        source: 'FILE_UPLOAD',
        video_size: 2048,
        chunk_size: 2048,
        total_chunk_count: 1,
      });
      expect(calls[1]!.url).toBe('https://up.test.local/x');
      expect(calls[1]!.init?.method).toBe('PUT');
      expect((calls[1]!.init?.headers as Record<string, string>)['content-range']).toBe(
        'bytes 0-2047/2048',
      );
    });

    it('rejects both or neither of videoUrl and videoFile', async () => {
      const a = createTikTokAdapter(config);
      await expect(a.publishVideo({})).rejects.toThrow(/exactly one/);
      await expect(
        a.publishVideo({ videoUrl: 'https://x/a.mp4', videoFile: { data: new Uint8Array(1), mimeType: 'video/mp4' } }),
      ).rejects.toThrow(/exactly one/);
    });

    it('surfaces the URL-ownership trap with the remediation step', async () => {
      mockApi(() => ({ error: { code: 'url_ownership_unverified', message: 'unverified' } }));
      await expect(
        createTikTokAdapter(config).publishVideo({ videoUrl: 'https://cdn.example.com/a.mp4' }),
      ).rejects.toThrow(/URL properties/);
    });
  });

  it('publishes a photo carousel with the chosen cover', async () => {
    const calls = mockApi(() => ok({ publish_id: 'pub-4' }));
    await createTikTokAdapter(config).publishPhotos({
      photoUrls: ['https://cdn.example.com/1.jpg', 'https://cdn.example.com/2.jpg'],
      coverIndex: 1,
      title: 'carousel',
    });
    const body = bodyOf(calls[0]!.init);
    expect(calls[0]!.url).toContain('/v2/post/publish/content/init/');
    expect(body.media_type).toBe('PHOTO');
    expect(body.source_info.photo_cover_index).toBe(1);
    expect(body.source_info.photo_images).toHaveLength(2);
  });

  it('reads publish status through TikTok\'s misspelled post-id field', async () => {
    mockApi(() =>
      ok({ status: 'PUBLISH_COMPLETE', publicaly_available_post_id: ['7300000000000000000'] }),
    );
    const status = await createTikTokAdapter(config).getPublishStatus('pub-1');
    expect(status.status).toBe('PUBLISH_COMPLETE');
    expect(status.publiclyAvailablePostIds).toEqual(['7300000000000000000']);
  });

  describe('send', () => {
    it('replies to a comment when metadata names one', async () => {
      const calls = mockApi(() => ok({ comment: { id: 'c-99' } }));
      const receipt = await createTikTokAdapter(config).send(
        outbound('thanks!', { videoId: 'v-1', commentId: 'c-1' }),
      );

      expect(receipt.status).toBe('sent');
      expect(receipt.externalId).toBe('c-99');
      expect(calls[0]!.url).toContain('/v2/video/comment/reply/create/');
      expect(bodyOf(calls[0]!.init)).toEqual({
        video_id: 'v-1',
        comment_id: 'c-1',
        text: 'thanks!',
      });
    });

    it('sends a DM through the configured messaging endpoint', async () => {
      const calls = mockApi(() => ok({ message_id: 'dm-1' }));
      const receipt = await createTikTokAdapter(dmConfig).send(
        outbound('hi there', { kind: 'dm', conversationId: 'conv-1' }),
      );

      expect(receipt.status).toBe('sent');
      expect(receipt.externalId).toBe('dm-1');
      expect(receipt.recipientId).toBe('conv-1');
      expect(calls[0]!.url).toBe('https://dm.test.local/messages/send');
      expect(bodyOf(calls[0]!.init)).toEqual({ conversation_id: 'conv-1', text: 'hi there' });
    });

    it('routes to a DM by default, using the contact as the conversation', async () => {
      const calls = mockApi(() => ok({ message_id: 'dm-2' }));
      await createTikTokAdapter(dmConfig).send(outbound('hello', undefined, 'conv-7'));
      expect(calls[0]!.url).toContain('/messages/send');
      expect(bodyOf(calls[0]!.init).conversation_id).toBe('conv-7');
    });

    it('explains the missing DM config rather than failing silently', async () => {
      mockApi(() => ok({}));
      const receipt = await createTikTokAdapter(config).send(
        outbound('hi', { kind: 'dm', conversationId: 'conv-1' }),
      );
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('tiktok_dm_not_configured');
      expect(receipt.error?.permanent).toBe(true);
      expect(receipt.error?.message).toMatch(/directMessages/);
    });

    it('fails a comment reply that names no comment', async () => {
      mockApi(() => ok({}));
      const receipt = await createTikTokAdapter(config).send(outbound('hi', { kind: 'comment' }));
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('tiktok_missing_comment_target');
    });

    it('rejects non-text content and points at the publish helpers', async () => {
      mockApi(() => ok({}));
      const receipt = await createTikTokAdapter(config).send({
        ...outbound(''),
        content: { type: 'video', mediaRef: { kind: 'url', value: 'https://x/a.mp4' } },
      } as never);
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.message).toMatch(/publishVideo/);
    });

    it('does not report a 5xx with an empty body as sent', async () => {
      mockApi(() => ({}), 502);
      const receipt = await createTikTokAdapter(config).send(
        outbound('hi', { videoId: 'v-1', commentId: 'c-1' }),
      );
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('tiktok_http_502');
      // The platform is struggling, not the message — retrying may work.
      expect(receipt.error?.permanent).toBe(false);
    });

    it('treats a thrown fetch as transient, never suppressing the recipient', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('ECONNRESET')) as unknown as typeof fetch;
      const receipt = await createTikTokAdapter(config).send(
        outbound('hi', { videoId: 'v-1', commentId: 'c-1' }),
      );
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('tiktok_network_error');
      expect(receipt.error?.permanent).toBe(false);
    });

    it('refuses an unrecognised kind rather than defaulting it to a DM', async () => {
      const calls = mockApi(() => ok({}));
      const receipt = await createTikTokAdapter(dmConfig).send(
        outbound('hi', { kind: 'video', conversationId: 'conv-1' }),
      );
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('tiktok_unknown_kind');
      expect(calls).toHaveLength(0);
    });

    it('marks a rate limit retryable and everything else permanent', async () => {
      mockApi(() => ({ error: { code: 'rate_limit_exceeded', message: 'slow down' } }));
      const limited = await createTikTokAdapter(config).send(
        outbound('hi', { videoId: 'v-1', commentId: 'c-1' }),
      );
      expect(limited.error?.permanent).toBe(false);

      mockApi(() => ({ error: { code: 'comment_not_found', message: 'gone' } }));
      const gone = await createTikTokAdapter(config).send(
        outbound('hi', { videoId: 'v-1', commentId: 'c-1' }),
      );
      expect(gone.error?.permanent).toBe(true);
    });
  });

  describe('poll', () => {
    const comments = (items: unknown[]) => ok({ comments: items });

    it('requests the comment fields explicitly — ids only, otherwise', async () => {
      const calls = mockApi(() => comments([]));
      await createTikTokAdapter({ ...config, watchVideoIds: ['v-1'] }).poll();
      expect(calls[0]!.url).toContain('/v2/video/comment/list/?fields=');
      expect(calls[0]!.url).toContain('create_time');
      expect(bodyOf(calls[0]!.init)).toEqual({ video_id: 'v-1', max_count: 20 });
    });

    it('emits nothing on the first poll, then only newer comments', async () => {
      mockApi(() =>
        comments([{ id: 'c-1', text: 'old', create_time: 1000, username: 'ann' }]),
      );
      const a = createTikTokAdapter({ ...config, watchVideoIds: ['v-1'] });

      // A cold start must not replay the whole comment history.
      expect(await a.poll()).toEqual([]);

      mockApi(() =>
        comments([
          { id: 'c-2', text: 'new', create_time: 2000, username: 'bob', user_id: 'u-2' },
          { id: 'c-1', text: 'old', create_time: 1000, username: 'ann' },
        ]),
      );
      const found = await a.poll();
      expect(found).toHaveLength(1);
      expect(found[0]!.content).toEqual({ type: 'text', text: 'new' });
      expect(found[0]!.contact.channelUserId).toBe('v-1');
      expect(found[0]!.metadata).toMatchObject({
        kind: 'comment',
        videoId: 'v-1',
        commentId: 'c-2',
        commenterId: 'u-2',
      });

      // The same comment must not come back a third time.
      expect(await a.poll()).toEqual([]);
    });

    it('produces a reply-ready message: send() takes the inbound metadata as-is', async () => {
      mockApi(() => comments([{ id: 'c-1', text: 'first', create_time: 1000 }]));
      const a = createTikTokAdapter({ ...config, watchVideoIds: ['v-1'] });
      await a.poll();
      mockApi(() => comments([{ id: 'c-2', text: 'question?', create_time: 2000 }]));
      const [inbound] = await a.poll();

      const calls = mockApi(() => ok({ comment: { id: 'c-3' } }));
      await a.send({ ...outbound('answer'), metadata: inbound!.metadata });
      expect(bodyOf(calls[0]!.init)).toEqual({
        video_id: 'v-1',
        comment_id: 'c-2',
        text: 'answer',
      });
    });

    it('keeps polling other videos when one video fails', async () => {
      // Prime both cursors, so the second poll is past the cold start.
      mockApi(() => comments([{ id: 'c-0', text: 'seed', create_time: 1000 }]));
      const a = createTikTokAdapter({ ...config, watchVideoIds: ['v-1', 'v-2'] });
      await a.poll();

      let call = 0;
      globalThis.fetch = vi.fn().mockImplementation(async (_url: string, init?: RequestInit) => {
        call += 1;
        if (JSON.parse((init?.body as string) ?? '{}').video_id === 'v-1') {
          throw new Error('video deleted');
        }
        return {
          ok: true,
          status: 200,
          json: async () => comments([{ id: 'c-9', text: 'still here', create_time: 5000 }]),
        } as Response;
      }) as unknown as typeof fetch;

      const found = await a.poll();
      expect(call).toBe(2);
      expect(found).toHaveLength(1);
      expect(found[0]!.metadata).toMatchObject({ videoId: 'v-2' });
    });

    it('polls direct messages when a listPath is configured', async () => {
      const calls = mockApi((url) =>
        url.includes('/messages/list')
          ? ok({
              messages: [
                {
                  conversation_id: 'conv-1',
                  message_id: 'dm-1',
                  text: 'hey',
                  from_open_id: 'u-1',
                  create_time: 3000,
                },
              ],
            })
          : ok({ comments: [] }),
      );
      const found = await createTikTokAdapter(dmConfig).poll();

      expect(calls.some((c) => c.url.startsWith('https://dm.test.local/messages/list'))).toBe(true);
      expect(found).toHaveLength(1);
      expect(found[0]!.content).toEqual({ type: 'text', text: 'hey' });
      expect(found[0]!.metadata).toMatchObject({ kind: 'dm', conversationId: 'conv-1' });
      expect(found[0]!.contact.channelUserId).toBe('conv-1');
    });

    it('restores cursors from the state store instead of replaying', async () => {
      const store = new Map<string, string>([
        ['msgly:tiktok:ckey:cursors', JSON.stringify({ comments: { 'v-1': 1000 } })],
      ]);
      mockApi(() =>
        comments([
          { id: 'c-2', text: 'new', create_time: 2000 },
          { id: 'c-1', text: 'old', create_time: 1000 },
        ]),
      );
      const a = createTikTokAdapter({
        ...config,
        watchVideoIds: ['v-1'],
        stateStore: {
          get: async (k: string) => store.get(k) ?? null,
          set: async (k: string, v: string) => void store.set(k, v),
          delete: async (k: string) => void store.delete(k),
        },
      });

      // Cursor came from the store, so the first poll already emits.
      const found = await a.poll();
      expect(found).toHaveLength(1);
      expect(found[0]!.metadata).toMatchObject({ commentId: 'c-2' });
      expect(JSON.parse(store.get('msgly:tiktok:ckey:cursors')!)).toEqual({
        comments: { 'v-1': 2000 },
      });
    });
  });

  describe('webhooks', () => {
    async function signed(body: string, secret = 'csecret', at = Date.now()) {
      const t = String(Math.floor(at / 1000));
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign'],
      );
      const digest = await crypto.subtle.sign(
        'HMAC',
        key,
        new TextEncoder().encode(`${t}.${body}`),
      );
      const hex = [...new Uint8Array(digest)]
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('');
      return {
        headers: { 'tiktok-signature': `t=${t},s=${hex}` },
        rawBody: new TextEncoder().encode(body),
        body: JSON.parse(body),
        query: {},
      };
    }

    it('accepts a correctly signed event and rejects a tampered one', async () => {
      const a = createTikTokAdapter(config);
      const req = await signed(JSON.stringify({ event: 'post.publish.complete' }));
      expect(await a.verifySignature(req)).toBe(true);

      const forged = await signed(JSON.stringify({ event: 'post.publish.complete' }), 'wrong');
      expect(await a.verifySignature(forged)).toBe(false);
      expect(await a.verifySignature({ ...req, headers: {} })).toBe(false);
    });

    it('rejects a correctly signed but stale request, bounding replay', async () => {
      const a = createTikTokAdapter(config);
      const body = JSON.stringify({ event: 'post.publish.complete' });
      const stale = await signed(body, 'csecret', Date.now() - 600_000);
      expect(await a.verifySignature(stale)).toBe(false);

      // The window is configurable for clock skew.
      const lenient = createTikTokAdapter({ ...config, webhookToleranceSec: 900 });
      expect(await lenient.verifySignature(stale)).toBe(true);
    });

    it('routes publish events to onEvent, parsing the JSON-string content', async () => {
      const a = createTikTokAdapter(config);
      const seen: unknown[] = [];
      a.onEvent((e) => seen.push(e));

      const produced = await a.handleWebhook({
        headers: {},
        rawBody: new Uint8Array(),
        query: {},
        body: {
          event: 'post.publish.complete',
          user_openid: 'open-1',
          content: '{"publish_id":"pub-1"}',
        },
      });

      expect(produced).toEqual([]);
      expect(seen).toEqual([
        expect.objectContaining({
          event: 'post.publish.complete',
          userOpenId: 'open-1',
          content: { publish_id: 'pub-1' },
        }),
      ]);
    });

    it('maps a DM event to an inbound message', async () => {
      const a = createTikTokAdapter(dmConfig);
      const produced = await a.handleWebhook({
        headers: {},
        rawBody: new Uint8Array(),
        query: {},
        body: {
          event: 'message.received',
          create_time: 4000,
          content: JSON.stringify({
            conversation_id: 'conv-2',
            message_id: 'dm-9',
            text: 'is this in stock?',
            from_open_id: 'u-3',
          }),
        },
      });

      expect(produced).toHaveLength(1);
      expect(produced[0]!.content).toEqual({ type: 'text', text: 'is this in stock?' });
      expect(produced[0]!.metadata).toMatchObject({ kind: 'dm', conversationId: 'conv-2' });
      expect(produced[0]!.timestamp).toBe(new Date(4_000_000).toISOString());
    });
  });

  describe('verifyCredentials', () => {
    it('reports the connected handle', async () => {
      mockApi(() => ok({ user: { username: 'acme', display_name: 'Acme' } }));
      const result = await createTikTokAdapter(config).verifyCredentials();
      expect(result).toEqual({ ok: true, accountInfo: '@acme' });
    });

    it('refuses an app with no user token, since publishing acts as a creator', async () => {
      const result = await createTikTokAdapter({
        clientKey: 'ckey',
        clientSecret: 'csecret',
      }).verifyCredentials();
      expect(result.ok).toBe(false);
      expect(result).toMatchObject({ reason: 'unauthorized' });
    });

    it('maps an invalid token to unauthorized', async () => {
      mockApi(() => ({ error: { code: 'access_token_invalid', message: 'expired' } }));
      const result = await createTikTokAdapter(config).verifyCredentials();
      expect(result).toMatchObject({ ok: false, reason: 'unauthorized' });
    });
  });

  it('refreshes an expired access token once for concurrent calls', async () => {
    const calls = mockApi((url) =>
      url.includes('/oauth/token/')
        ? { access_token: 'tok-2', expires_in: 86400 }
        : ok({ comments: [] }),
    );
    const a = createTikTokAdapter({ ...config, accessToken: undefined, refreshToken: 'refresh-1' });

    await Promise.all([a.getPublishStatus('pub-1').catch(() => undefined), a.poll()]);
    const tokenCalls = calls.filter((c) => c.url.includes('/oauth/token/'));
    expect(tokenCalls).toHaveLength(1);
  });

  it('has no standalone media store — uploadMedia says where bytes go instead', async () => {
    await expect(
      createTikTokAdapter(config).uploadMedia({ data: new Uint8Array(1), mimeType: 'video/mp4' }),
    ).rejects.toThrow(/publishVideo/);
  });
});

describe('tiktokErrorOf', () => {
  it('treats code "ok" as success and anything else as an error', () => {
    expect(tiktokErrorOf({ error: { code: 'ok', message: '' } })).toBeNull();
    expect(tiktokErrorOf({ data: {} })).toBeNull();
    expect(tiktokErrorOf({ error: { code: 'spam_risk_too_many_posts', message: 'wait' } })).toEqual({
      code: 'spam_risk_too_many_posts',
      message: 'wait',
    });
  });
});
