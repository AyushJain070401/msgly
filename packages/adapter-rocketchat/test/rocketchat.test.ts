import { afterEach, describe, expect, it, vi } from 'vitest';

import { createRocketChatAdapter, fmt } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  serverUrl: 'https://chat.test.local',
  authToken: 'tok-abc',
  userId: 'user-1',
  defaultRoomId: 'room-default',
};

const account = { channel: 'rocketchat' as const, channelAccountId: 'room-1' };
const contact = { channel: 'rocketchat' as const, channelUserId: 'room-1' };

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
  content: Parameters<ReturnType<typeof createRocketChatAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'rocketchat' as const,
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

describe('createRocketChatAdapter', () => {
  it('declares the rocketchat channel and its capabilities', () => {
    const a = createRocketChatAdapter(baseConfig);
    expect(a.channel).toBe('rocketchat');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(true);
    expect(a.capabilities.reactions).toBe(true);
  });

  it('sends a text message with both auth headers', async () => {
    const calls = mockApi({ success: true, message: { _id: 'msg-1' } });
    const a = createRocketChatAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hello team' }));

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('msg-1');
    expect(calls[0]!.url).toBe('https://chat.test.local/api/v1/chat.postMessage');

    // Rocket.Chat needs BOTH headers — a token alone is rejected.
    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['X-Auth-Token']).toBe('tok-abc');
    expect(headers['X-User-Id']).toBe('user-1');

    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      roomId: 'room-1',
      text: 'hello team',
    });
  });

  it('appends /api/v1 without duplicating slashes', async () => {
    const calls = mockApi({ success: true, message: { _id: 'x' } });
    const a = createRocketChatAdapter({ ...baseConfig, serverUrl: 'https://chat.test.local/' });
    await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(calls[0]!.url).toBe('https://chat.test.local/api/v1/chat.postMessage');
  });

  it('treats success:false as failure even on HTTP 200', async () => {
    // Rocket.Chat reports errors through the success flag, sometimes with 200.
    mockApi({ success: false, error: 'invalid-room', errorType: 'error-invalid-room' }, 200);

    const a = createRocketChatAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('rocketchat_error-invalid-room');
    expect(receipt.error?.message).toBe('invalid-room');
  });

  it('threads a reply with tmid', async () => {
    const calls = mockApi({ success: true, message: { _id: 'msg-2' } });
    const a = createRocketChatAdapter(baseConfig);
    await a.send(
      outbound({ type: 'text', text: 'reply' }, { metadata: { messageId: 'parent-1' } }),
    );
    expect(JSON.parse(calls[0]!.init!.body as string).tmid).toBe('parent-1');
  });

  it('falls back to defaultRoomId, and fails clearly with no room at all', async () => {
    const calls = mockApi({ success: true, message: { _id: 'x' } });
    const a = createRocketChatAdapter(baseConfig);
    await a.send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'rocketchat', channelUserId: '' },
    });
    expect(JSON.parse(calls[0]!.init!.body as string).roomId).toBe('room-default');

    const noRoom = createRocketChatAdapter({ ...baseConfig, defaultRoomId: undefined });
    const receipt = await noRoom.send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'rocketchat', channelUserId: '' },
    });
    expect(receipt.error?.code).toBe('rocketchat_missing_room');
  });

  it('links an image as an attachment', async () => {
    const calls = mockApi({ success: true, message: { _id: 'msg-3' } });
    const a = createRocketChatAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.test/p.png' },
        caption: 'chart',
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.attachments[0]).toMatchObject({
      image_url: 'https://cdn.test/p.png',
      title: 'chart',
    });
  });

  it('refuses media with a platform-id ref', async () => {
    const calls = mockApi({ success: true });
    const a = createRocketChatAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'platform-id', value: 'x' } }),
    );

    expect(receipt.error?.code).toBe('rocketchat_media_url_required');
    expect(calls).toHaveLength(0);
  });

  it('renders interactive buttons as attachment actions', async () => {
    const calls = mockApi({ success: true, message: { _id: 'msg-4' } });
    const a = createRocketChatAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'interactive',
        text: 'Deploy?',
        buttons: [[{ id: 'yes', label: 'Ship' }], [{ id: 'no', label: 'Wait' }]],
      }),
    );

    const actions = JSON.parse(calls[0]!.init!.body as string).attachments[0].actions;
    expect(actions).toHaveLength(2);
    expect(actions[0]).toMatchObject({ type: 'button', text: 'Ship', msg: 'yes' });
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const a = createRocketChatAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(receipt.error?.code).toBe('rocketchat_network_error');
  });

  it('parses an inbound outgoing-webhook post', async () => {
    const a = createRocketChatAdapter(baseConfig);
    const messages = await a.handleWebhook(
      webhook({
        token: 'wh',
        text: 'hello bot',
        user_id: 'u-1',
        user_name: 'alice',
        channel_id: 'room-1',
        channel_name: 'general',
        message_id: 'msg-9',
        timestamp: '2026-01-01T10:00:00.000Z',
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('hello bot');
    // The room is the conversation, so replies address the room.
    expect(m.contact.channelUserId).toBe('room-1');
    expect(m.contact.displayName).toBe('alice');
    expect(m.metadata?.userId).toBe('u-1');
    expect(m.metadata?.channelName).toBe('general');
    expect(m.externalId).toBe('msg-9');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('ignores bot posts, which would otherwise loop', async () => {
    const a = createRocketChatAdapter(baseConfig);
    expect(
      await a.handleWebhook(
        webhook({ text: 'echo', user_id: 'u1', channel_id: 'r1', bot: { i: 'x' } }),
      ),
    ).toEqual([]);
  });

  it('ignores empty text and payloads missing ids', async () => {
    const a = createRocketChatAdapter(baseConfig);
    expect(
      await a.handleWebhook(webhook({ text: '  ', user_id: 'u1', channel_id: 'r1' })),
    ).toEqual([]);
    expect(await a.handleWebhook(webhook({ text: 'hi' }))).toEqual([]);
  });

  it('verifies the webhook token in constant time', async () => {
    const a = createRocketChatAdapter({ ...baseConfig, webhookToken: 'wh-secret' });
    expect(await a.verifySignature(webhook({ token: 'wh-secret' }))).toBe(true);
    expect(await a.verifySignature(webhook({ token: 'nope' }))).toBe(false);
    expect(await a.verifySignature(webhook({}))).toBe(false);
  });

  it('accepts everything when no webhook token is configured', async () => {
    const a = createRocketChatAdapter(baseConfig);
    expect(await a.verifySignature(webhook({}))).toBe(true);
  });

  it('resolves a room id from a channel name', async () => {
    const calls = mockApi({ success: true, channel: { _id: 'room-42' } });
    const a = createRocketChatAdapter(baseConfig);
    expect(await a.getRoomId('general')).toBe('room-42');
    expect(calls[0]!.url).toContain('/channels.info?roomName=general');
  });

  it('returns null when the channel does not exist', async () => {
    mockApi({ success: false }, 200);
    const a = createRocketChatAdapter(baseConfig);
    expect(await a.getRoomId('nope')).toBeNull();
  });

  it('uploadMedia requires a room', async () => {
    const a = createRocketChatAdapter({ ...baseConfig, defaultRoomId: undefined });
    await expect(
      a.uploadMedia({ data: encode('x'), mimeType: 'text/plain' }),
    ).rejects.toThrow('defaultRoomId');
  });

  it('uploadMedia returns a downloadable file reference', async () => {
    mockApi({ success: true, message: { _id: 'm1', file: { _id: 'file-7' } } });
    const a = createRocketChatAdapter(baseConfig);
    const ref = await a.uploadMedia({
      data: encode('PDF'),
      mimeType: 'application/pdf',
      filename: 'r.pdf',
    });

    expect(ref.kind).toBe('url');
    expect(ref.value).toContain('/file-upload/file-7/r.pdf');
  });

  it('verifyCredentials reports the username', async () => {
    mockApi({ success: true, username: 'acme-bot' });
    const result = await createRocketChatAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('@acme-bot');
  });

  it('verifyCredentials explains that both token and user id are needed', async () => {
    const result = await createRocketChatAdapter({
      ...baseConfig,
      userId: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('BOTH');
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    mockApi({}, 401);
    const result = await createRocketChatAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('same account');
    }
  });

  it('verifyCredentials flags a serverUrl that already includes /api/v1', async () => {
    mockApi({}, 404);
    const result = await createRocketChatAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.hint).toContain('without /api/v1');
    }
  });
});

describe('fmt', () => {
  it('produces Rocket.Chat markdown', () => {
    // Rocket.Chat uses single asterisks for bold, unlike Mattermost.
    expect(fmt.bold('x')).toBe('*x*');
    expect(fmt.italic('x')).toBe('_x_');
    expect(fmt.link('t', 'https://u')).toBe('[t](https://u)');
  });

  it('escapes markdown control characters', () => {
    expect(fmt.escape('a*b_c')).toBe('a\\*b\\_c');
  });
});
