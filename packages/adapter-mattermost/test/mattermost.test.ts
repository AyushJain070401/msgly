import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMattermostAdapter, fmt } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  serverUrl: 'https://chat.test.local',
  accessToken: 'tok-123',
  defaultChannelId: 'chan-default',
};

const account = { channel: 'mattermost' as const, channelAccountId: 'chan-1' };
const contact = { channel: 'mattermost' as const, channelUserId: 'chan-1' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockApi(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status < 400,
      status,
      json: async () => payload,
      arrayBuffer: async () => new TextEncoder().encode('BYTES').buffer,
      headers: { get: () => 'application/pdf' },
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createMattermostAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'mattermost' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function webhook(body: Record<string, unknown>) {
  return { headers: {}, rawBody: encode(''), body, query: {} };
}

describe('createMattermostAdapter', () => {
  it('declares the mattermost channel and its capabilities', () => {
    const a = createMattermostAdapter(baseConfig);
    expect(a.channel).toBe('mattermost');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(true);
    expect(a.capabilities.interactive.buttons).toBe(true);
    expect(a.capabilities.reactions).toBe(true);
  });

  it('appends /api/v4 to the server url without duplicating slashes', async () => {
    const calls = mockApi({ id: 'post-1' });
    const a = createMattermostAdapter({ ...baseConfig, serverUrl: 'https://chat.test.local/' });
    await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(calls[0]!.url).toBe('https://chat.test.local/api/v4/posts');
  });

  it('posts a text message to the channel', async () => {
    const calls = mockApi({ id: 'post-1' });
    const a = createMattermostAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hello team' }));

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('post-1');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer tok-123');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({ channel_id: 'chan-1', message: 'hello team' });
  });

  it('threads a reply under the original post', async () => {
    const calls = mockApi({ id: 'post-2' });
    const a = createMattermostAdapter(baseConfig);
    await a.send(outbound({ type: 'text', text: 'reply' }, { metadata: { postId: 'root-1' } }));

    expect(JSON.parse(calls[0]!.init!.body as string).root_id).toBe('root-1');
  });

  it('falls back to defaultChannelId when the contact has no channel', async () => {
    const calls = mockApi({ id: 'post-3' });
    const a = createMattermostAdapter(baseConfig);
    await a.send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'mattermost', channelUserId: '' },
    });

    expect(JSON.parse(calls[0]!.init!.body as string).channel_id).toBe('chan-default');
  });

  it('fails clearly when there is no channel at all', async () => {
    const calls = mockApi({ id: 'x' });
    const a = createMattermostAdapter({ ...baseConfig, defaultChannelId: undefined });
    const receipt = await a.send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'mattermost', channelUserId: '' },
    });

    expect(receipt.error?.code).toBe('mattermost_missing_channel');
    expect(calls).toHaveLength(0);
  });

  it('attaches a file by id', async () => {
    const calls = mockApi({ id: 'post-4' });
    const a = createMattermostAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'file',
        mediaRef: { kind: 'platform-id', value: 'file-9' },
        caption: 'the report',
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.file_ids).toEqual(['file-9']);
    expect(body.message).toBe('the report');
  });

  it('refuses a media send with a url ref, since Mattermost needs a file id', async () => {
    const calls = mockApi({ id: 'x' });
    const a = createMattermostAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'https://x/y.png' } }),
    );

    expect(receipt.error?.code).toBe('mattermost_file_id_required');
    expect(receipt.error?.message).toContain('uploadMedia');
    expect(calls).toHaveLength(0);
  });

  it('renders interactive buttons as message attachment actions', async () => {
    const calls = mockApi({ id: 'post-5' });
    const a = createMattermostAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'interactive',
        text: 'Deploy?',
        buttons: [[{ id: 'yes', label: 'Ship it' }], [{ id: 'no', label: 'Hold' }]],
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    const actions = body.props.attachments[0].actions;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ id: 'yes', name: 'Ship it', type: 'button' });
  });

  it('renders a location as a maps link', async () => {
    const calls = mockApi({ id: 'post-6' });
    const a = createMattermostAdapter(baseConfig);
    await a.send(outbound({ type: 'location', latitude: 1.5, longitude: 2.5, name: 'HQ' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.message).toContain('HQ');
    expect(body.message).toContain('q=1.5,2.5');
  });

  it('surfaces an API error', async () => {
    mockApi({ message: 'Unable to post to channel', status_code: 403 }, 403);
    const a = createMattermostAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('mattermost_403');
    expect(receipt.error?.message).toBe('Unable to post to channel');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const a = createMattermostAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(receipt.error?.code).toBe('mattermost_network_error');
  });

  it('parses an inbound outgoing-webhook post', async () => {
    const a = createMattermostAdapter(baseConfig);
    const messages = await a.handleWebhook(
      webhook({
        token: 'wh-token',
        text: 'hello bot',
        user_id: 'user-1',
        user_name: 'alice',
        channel_id: 'chan-1',
        team_id: 'team-1',
        post_id: 'post-9',
        timestamp: 1767261600000,
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('hello bot');
    // Replies go to the channel, so that is the addressable id.
    expect(m.contact.channelUserId).toBe('chan-1');
    expect(m.contact.displayName).toBe('alice');
    expect(m.metadata?.userId).toBe('user-1');
    expect(m.metadata?.postId).toBe('post-9');
    expect(m.externalId).toBe('post-9');
    expect(m.timestamp).toBe(new Date(1767261600000).toISOString());
  });

  it('ignores the bot’s own posts, which would otherwise loop', async () => {
    const a = createMattermostAdapter(baseConfig);
    const messages = await a.handleWebhook(
      webhook({ text: 'echo', user_id: 'u1', channel_id: 'c1', user_name: 'bot' }),
    );
    expect(messages).toEqual([]);
  });

  it('ignores empty posts and payloads missing ids', async () => {
    const a = createMattermostAdapter(baseConfig);
    expect(
      await a.handleWebhook(webhook({ text: '   ', user_id: 'u1', channel_id: 'c1' })),
    ).toEqual([]);
    expect(await a.handleWebhook(webhook({ text: 'hi' }))).toEqual([]);
  });

  it('verifies the outgoing-webhook token in constant time', async () => {
    // Mattermost does not sign bodies — the shared token is the only guard.
    const a = createMattermostAdapter({ ...baseConfig, webhookToken: 'wh-secret' });
    expect(await a.verifySignature(webhook({ token: 'wh-secret' }))).toBe(true);
    expect(await a.verifySignature(webhook({ token: 'wrong' }))).toBe(false);
    expect(await a.verifySignature(webhook({}))).toBe(false);
  });

  it('accepts everything when no webhook token is configured', async () => {
    const a = createMattermostAdapter(baseConfig);
    expect(await a.verifySignature(webhook({}))).toBe(true);
  });

  it('resolves a channel id from team and channel names', async () => {
    const calls = mockApi({ id: 'chan-42' });
    const a = createMattermostAdapter(baseConfig);
    const id = await a.getChannelId('acme', 'general');

    expect(id).toBe('chan-42');
    expect(calls[0]!.url).toContain('/teams/name/acme/channels/name/general');
  });

  it('returns null when the channel is not found', async () => {
    mockApi({}, 404);
    const a = createMattermostAdapter(baseConfig);
    expect(await a.getChannelId('acme', 'nope')).toBeNull();
  });

  it('uploadMedia requires a channel to upload into', async () => {
    const a = createMattermostAdapter({ ...baseConfig, defaultChannelId: undefined });
    await expect(
      a.uploadMedia({ data: encode('x'), mimeType: 'text/plain' }),
    ).rejects.toThrow('defaultChannelId');
  });

  it('uploadMedia returns the file id', async () => {
    mockApi({ file_infos: [{ id: 'file-77' }] });
    const a = createMattermostAdapter(baseConfig);
    const ref = await a.uploadMedia({
      data: encode('PDF'),
      mimeType: 'application/pdf',
      filename: 'r.pdf',
    });

    expect(ref).toMatchObject({
      kind: 'platform-id',
      value: 'file-77',
      mimeType: 'application/pdf',
      filename: 'r.pdf',
    });
  });

  it('verifyCredentials reports the bot username', async () => {
    mockApi({ username: 'acme-bot', id: 'u-1' });
    const result = await createMattermostAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('@acme-bot');
  });

  it('verifyCredentials explains that tokens may be disabled server-side', async () => {
    mockApi({}, 401);
    const result = await createMattermostAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('System Console');
    }
  });

  it('verifyCredentials flags a serverUrl that already includes /api/v4', async () => {
    mockApi({}, 404);
    const result = await createMattermostAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.hint).toContain('without /api/v4');
    }
  });

  it('verifyCredentials returns a hint when the token is missing', async () => {
    const result = await createMattermostAdapter({
      ...baseConfig,
      accessToken: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('accessToken');
  });
});

describe('fmt', () => {
  it('produces Mattermost markdown', () => {
    expect(fmt.bold('x')).toBe('**x**');
    expect(fmt.link('t', 'https://u')).toBe('[t](https://u)');
  });

  it('escapes markdown control characters in untrusted text', () => {
    expect(fmt.escape('a*b_c[d]')).toBe('a\\*b\\_c\\[d\\]');
  });
});
