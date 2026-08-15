import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTelegramAdapter } from '../src/index.js';

const config = {
  botToken: '123:ABC-DEF',
  webhookSecret: 'shh',
};

const encode = (s: string) => new TextEncoder().encode(s);

describe('createTelegramAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createTelegramAdapter(config);
    expect(a.channel).toBe('telegram');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
    expect(a.capabilities.templates).toBe(false);
  });

  it('verifies webhook secret token', async () => {
    const a = createTelegramAdapter(config);
    expect(
      await a.verifySignature({
        headers: { 'x-telegram-bot-api-secret-token': 'shh' },
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects wrong webhook secret token', async () => {
    const a = createTelegramAdapter(config);
    expect(
      await a.verifySignature({
        headers: { 'x-telegram-bot-api-secret-token': 'wrong' },
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('skips signature check when webhookSecret is unset', async () => {
    const a = createTelegramAdapter({ botToken: 'x' });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('parses an inbound text message', async () => {
    const a = createTelegramAdapter(config);
    const update = {
      update_id: 1,
      message: {
        message_id: 42,
        date: 1700000000,
        chat: { id: 999, first_name: 'Udesh' },
        from: { id: 999, first_name: 'Udesh' },
        text: 'hi telegram',
      },
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: update,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('telegram');
    expect((m.content as { text: string }).text).toBe('hi telegram');
    expect(m.contact.channelUserId).toBe('999');
    expect(m.contact.displayName).toBe('Udesh');
  });

  it('parses an inbound photo message with caption', async () => {
    const a = createTelegramAdapter(config);
    const update = {
      update_id: 2,
      message: {
        message_id: 43,
        date: 1700000000,
        chat: { id: 999 },
        photo: [{ file_id: 'small' }, { file_id: 'large' }],
        caption: 'a picture',
      },
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: update,
      query: {},
    });
    const c = messages[0]!.content as {
      type: string;
      mediaRef: { value: string };
      caption: string;
    };
    expect(c.type).toBe('image');
    expect(c.mediaRef.value).toBe('large'); // picks the largest
    expect(c.caption).toBe('a picture');
  });

  it('verifyCredentials returns hint when token is empty', async () => {
    const a = createTelegramAdapter({ botToken: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('@BotFather');
    }
  });
});

// ---------------------------------------------------------------------------
// send() and interaction handling — previously untested.
// ---------------------------------------------------------------------------

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockSend(payload: unknown = { ok: true, result: { message_id: 55 } }) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  function outbound(
    content: Parameters<ReturnType<typeof createTelegramAdapter>['send']>[0]['content'],
    channelUserId = '4242',
  ) {
    return {
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'telegram' as const,
      account: { channel: 'telegram' as const, channelAccountId: 'bot' },
      contact: { channel: 'telegram' as const, channelUserId },
      content,
      timestamp: new Date().toISOString(),
    };
  }

  const bodyOf = (calls: Array<{ init?: RequestInit }>) =>
    JSON.parse(calls[0]!.init!.body as string);

  it('sends text via sendMessage and returns the message id', async () => {
    const calls = mockSend();
    const receipt = await createTelegramAdapter(config).send(
      outbound({ type: 'text', text: 'hello' }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('55');
    expect(calls[0]!.url).toContain('/bot123:ABC-DEF/sendMessage');
    expect(bodyOf(calls)).toEqual({ chat_id: '4242', text: 'hello' });
  });

  it('posts to a channel when the chat id is an @username', async () => {
    // A Telegram channel is just another chat_id — this is what makes
    // broadcast work with no extra API.
    const calls = mockSend();
    await createTelegramAdapter(config).send(
      outbound({ type: 'text', text: 'Shipped v2' }, '@acme_announcements'),
    );
    expect(bodyOf(calls).chat_id).toBe('@acme_announcements');
  });

  it('picks the right method for each media type', async () => {
    for (const [type, method] of [
      ['image', 'sendPhoto'],
      ['video', 'sendVideo'],
      ['audio', 'sendAudio'],
      ['file', 'sendDocument'],
    ] as const) {
      const calls = mockSend();
      await createTelegramAdapter(config).send(
        outbound({ type, mediaRef: { kind: 'url', value: 'https://cdn/x' } }),
      );
      expect(calls[0]!.url).toContain(`/${method}`);
    }
  });

  it('sends a location via sendLocation', async () => {
    const calls = mockSend();
    await createTelegramAdapter(config).send(
      outbound({ type: 'location', latitude: 1.5, longitude: 2.5 }),
    );

    expect(calls[0]!.url).toContain('/sendLocation');
    expect(bodyOf(calls)).toMatchObject({ latitude: 1.5, longitude: 2.5 });
  });

  it('builds an inline keyboard by default, preserving 2D rows', async () => {
    const calls = mockSend();
    await createTelegramAdapter(config).send(
      outbound({
        type: 'interactive',
        text: 'Pick',
        buttons: [
          [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
          [{ id: 'c', label: 'C' }],
        ],
      }),
    );

    const kb = bodyOf(calls).reply_markup.inline_keyboard;
    // The 2D shape is the row layout — flattening it would lose the grid.
    expect(kb).toHaveLength(2);
    expect(kb[0]).toHaveLength(2);
    expect(kb[0][0]).toEqual({ text: 'A', callback_data: 'a' });
  });

  it('builds a reply keyboard when asked, which carries labels not ids', async () => {
    const calls = mockSend();
    await createTelegramAdapter(config).send(
      outbound({
        type: 'interactive',
        text: 'Pick',
        keyboardType: 'reply',
        buttons: [{ id: 'yes', label: 'Yes' }],
      }),
    );

    const markup = bodyOf(calls).reply_markup;
    expect(markup.keyboard[0][0]).toEqual({ text: 'Yes' });
    expect(markup.inline_keyboard).toBeUndefined();
  });

  it('surfaces a Telegram API error description', async () => {
    mockSend({ ok: false, description: 'chat not found' });
    const receipt = await createTelegramAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.message).toBe('chat not found');
  });
});

describe('fmt', () => {
  it('escapes every MarkdownV2 reserved character', async () => {
    const { fmt } = await import('../src/index.js');
    // Telegram rejects the whole message if one of these is unescaped.
    expect(fmt.escape('a_b*c[d]e(f)~g`h>i#j+k-l=m|n{o}p.q!')).toBe(
      'a\\_b\\*c\\[d\\]e\\(f\\)\\~g\\`h\\>i\\#j\\+k\\-l\\=m\\|n\\{o\\}p\\.q\\!',
    );
  });

  it('wraps text in MarkdownV2 markers', async () => {
    const { fmt } = await import('../src/index.js');
    expect(fmt.bold('hi')).toBe('*hi*');
    expect(fmt.italic('hi')).toBe('_hi_');
  });
});
