import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRedditAdapter, thingTypeOf } from '../src/index.js';

const config = {
  clientId: 'cid',
  clientSecret: 'csecret',
  username: 'acme_bot',
  password: 'hunter2',
  userAgent: 'node:msgly-test:1.0.0 (by /u/acme_bot)',
  defaultSubreddit: 'acme',
  authBase: 'https://www.test.local',
  apiBase: 'https://oauth.test.local',
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
    if (url.includes('/api/v1/access_token')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ access_token: 'tok-1', expires_in: 3600 }),
      } as Response;
    }
    return { ok: status < 400, status, json: async () => responder(url) } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const formOf = (init?: RequestInit) => new URLSearchParams((init?.body as string) ?? '');

function outbound(text: string, metadata?: Record<string, unknown>, channelUserId = '') {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'reddit' as const,
    account: { channel: 'reddit' as const, channelAccountId: 'acme_bot' },
    contact: { channel: 'reddit' as const, channelUserId },
    content: { type: 'text' as const, text },
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

describe('createRedditAdapter', () => {
  it('declares the reddit channel as text-only', () => {
    const a = createRedditAdapter(config);
    expect(a.channel).toBe('reddit');
    expect(a.capabilities.text).toBe(true);
    // Media upload uses a separate lease flow this adapter does not implement.
    expect(a.capabilities.media.image).toBe(false);
  });

  it('authenticates with Basic auth and sends the required User-Agent', async () => {
    const calls = mockApi(() => ({ name: 'acme_bot' }));
    await createRedditAdapter(config).verifyCredentials();

    const tokenCall = calls.find((c) => c.url.includes('access_token'))!;
    const headers = tokenCall.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa('cid:csecret')}`);
    // Reddit throttles generic agents, so this must be present on every call.
    expect(headers['user-agent']).toContain('msgly-test');
    expect(formOf(tokenCall.init).get('grant_type')).toBe('password');

    const apiCall = calls.find((c) => c.url.includes('/api/v1/me'))!;
    expect((apiCall.init!.headers as Record<string, string>)['user-agent']).toBeTruthy();
  });

  it('caches the token and collapses concurrent refreshes', async () => {
    const calls = mockApi(() => ({ name: 'acme_bot' }));
    const a = createRedditAdapter(config);
    await Promise.all([a.verifyCredentials(), a.verifyCredentials(), a.verifyCredentials()]);
    expect(calls.filter((c) => c.url.includes('access_token'))).toHaveLength(1);
  });

  it('submits a self post to the default subreddit', async () => {
    const calls = mockApi(() => ({
      json: { errors: [], data: { name: 't3_abc', url: 'https://reddit.com/r/acme/abc' } },
    }));

    const result = await createRedditAdapter(config).publishPost({
      title: 'We shipped v2',
      text: 'Full changelog inside.',
    });

    expect(result).toEqual({ id: 't3_abc', url: 'https://reddit.com/r/acme/abc' });

    const submit = calls.find((c) => c.url.includes('/api/submit'))!;
    const form = formOf(submit.init);
    expect(form.get('sr')).toBe('acme');
    expect(form.get('kind')).toBe('self');
    expect(form.get('text')).toBe('Full changelog inside.');
  });

  it('submits a link post and strips an r/ prefix', async () => {
    const calls = mockApi(() => ({ json: { errors: [], data: { name: 't3_x' } } }));
    await createRedditAdapter(config).publishPost({
      subreddit: 'r/other',
      title: 'Blog post',
      url: 'https://acme.com/blog',
    });

    const form = formOf(calls.find((c) => c.url.includes('/api/submit'))!.init);
    expect(form.get('sr')).toBe('other');
    expect(form.get('kind')).toBe('link');
    expect(form.get('url')).toBe('https://acme.com/blog');
  });

  it('treats the errors array as the real result despite HTTP 200', async () => {
    // Reddit returns 200 with a populated errors array rather than a status.
    mockApi(() => ({
      json: { errors: [['RATELIMIT', 'you are doing that too much, try again in 8 minutes', 'ratelimit']] },
    }));

    await expect(
      createRedditAdapter(config).publishPost({ title: 't', text: 'b' }),
    ).rejects.toThrow('RATELIMIT');
  });

  it('rejects a post that is both a self post and a link', async () => {
    const a = createRedditAdapter(config);
    await expect(
      a.publishPost({ title: 't', text: 'x', url: 'https://y' }),
    ).rejects.toThrow('not both');
    await expect(a.publishPost({ title: 't' })).rejects.toThrow('text (self post) or url');
  });

  it('requires a subreddit', async () => {
    const a = createRedditAdapter({ ...config, defaultSubreddit: undefined });
    await expect(a.publishPost({ title: 't', text: 'x' })).rejects.toThrow('defaultSubreddit');
  });

  it('replies to a thing id', async () => {
    const calls = mockApi(() => ({
      json: { errors: [], data: { things: [{ data: { name: 't1_reply' } }] } },
    }));

    const receipt = await createRedditAdapter(config).send(
      outbound('Thanks for the report!', { thingId: 't1_parent' }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('t1_reply');

    const form = formOf(calls.find((c) => c.url.includes('/api/comment'))!.init);
    expect(form.get('thing_id')).toBe('t1_parent');
    expect(form.get('text')).toBe('Thanks for the report!');
  });

  it('refuses a send with no reply target, and says why', async () => {
    const calls = mockApi(() => ({}));
    const receipt = await createRedditAdapter(config).send(outbound('buy my thing'));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('reddit_missing_thing_id');
    // The adapter deliberately offers no bulk-DM path.
    expect(receipt.error?.message).toContain('spam');
    expect(receipt.error?.message).toContain('publishPost()');
    expect(calls.filter((c) => c.url.includes('/api/comment'))).toHaveLength(0);
  });

  it('rejects an unrecognised thing id prefix', async () => {
    mockApi(() => ({}));
    const receipt = await createRedditAdapter(config).send(
      outbound('hi', { thingId: 'not-a-fullname' }),
    );
    expect(receipt.error?.code).toBe('reddit_missing_thing_id');
  });

  it('marks a rate limit retryable but other errors permanent', async () => {
    mockApi(() => ({ json: { errors: [['RATELIMIT', 'too fast', 'ratelimit']] } }));
    const limited = await createRedditAdapter(config).send(outbound('x', { thingId: 't3_a' }));
    expect(limited.error?.permanent).toBe(false);

    mockApi(() => ({ json: { errors: [['THREAD_LOCKED', 'thread is locked', '']] } }));
    const locked = await createRedditAdapter(config).send(outbound('x', { thingId: 't3_a' }));
    expect(locked.error?.permanent).toBe(true);
  });

  it('polls the inbox and addresses replies to the thing, not the user', async () => {
    const calls = mockApi((url) =>
      url.includes('/message/unread')
        ? {
            data: {
              children: [
                {
                  kind: 't1',
                  data: {
                    name: 't1_new',
                    author: 'curious_user',
                    body: 'does this support X?',
                    subreddit: 'acme',
                    was_comment: true,
                    created_utc: 1767261600,
                    link_title: 'We shipped v2',
                  },
                },
              ],
            },
          }
        : {},
    );

    const messages = await createRedditAdapter(config).poll();

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('does this support X?');
    expect(m.contact.displayName).toBe('curious_user');
    // /api/comment expects the thing fullname back, so that is the address.
    expect(m.contact.channelUserId).toBe('t1_new');
    expect(m.metadata?.kind).toBe('comment');
    expect(m.metadata?.subreddit).toBe('acme');
    expect(m.timestamp).toBe(new Date(1767261600 * 1000).toISOString());

    // Items are cleared so Reddit stops returning them.
    expect(calls.some((c) => c.url.includes('/api/read_message'))).toBe(true);
  });

  it('resumes from a persisted cursor', async () => {
    const store = new Map<string, string>([['msgly:reddit:acme_bot:lastSeen', 't1_old']]);
    const calls = mockApi(() => ({ data: { children: [] } }));

    await createRedditAdapter({
      ...config,
      stateStore: {
        get: async (k) => store.get(k) ?? null,
        set: async (k, v) => void store.set(k, v),
      },
    }).poll();

    expect(calls.find((c) => c.url.includes('/message/unread'))!.url).toContain('before=t1_old');
  });

  it('skips inbox items with no body or author', async () => {
    mockApi(() => ({ data: { children: [{ data: { name: 't1_x', author: 'u' } }] } }));
    expect(await createRedditAdapter(config).poll()).toEqual([]);
  });

  it('verifyCredentials insists on a descriptive user agent', async () => {
    const result = await createRedditAdapter({ ...config, userAgent: '  ' }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('throttles generic agents');
  });

  it('verifyCredentials explains the script-app and 2FA requirements on 401', async () => {
    mockApi(() => ({}), 401);
    const result = await createRedditAdapter(config).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('script');
    }
  });

  it('verifyCredentials reports the account name on success', async () => {
    mockApi(() => ({ name: 'acme_bot' }));
    const result = await createRedditAdapter(config).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toBe('u/acme_bot');
  });

  it('rejects media operations with an explanation', async () => {
    const a = createRedditAdapter(config);
    await expect(
      a.uploadMedia({ data: new TextEncoder().encode('x'), mimeType: 'image/png' }),
    ).rejects.toThrow('link post');
  });
});

describe('thingTypeOf', () => {
  it('maps Reddit fullname prefixes', () => {
    expect(thingTypeOf('t1_abc')).toBe('comment');
    expect(thingTypeOf('t3_abc')).toBe('post');
    expect(thingTypeOf('t4_abc')).toBe('message');
    expect(thingTypeOf('abc')).toBe('unknown');
  });
});
