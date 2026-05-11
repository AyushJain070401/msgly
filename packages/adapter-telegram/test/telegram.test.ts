import { describe, expect, it } from 'vitest';

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
