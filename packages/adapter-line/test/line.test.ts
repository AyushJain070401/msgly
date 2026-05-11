import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { LineAdapter } from '../src/index.js';

const config = {
  channelAccessToken: 'test-token',
  channelSecret: 'test-secret',
};

const sign = (body: Buffer): string =>
  createHmac('sha256', config.channelSecret).update(body).digest('base64');

describe('LineAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = new LineAdapter(config);
    expect(a.channel).toBe('line');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(false);
  });

  it('verifies a valid signature', () => {
    const a = new LineAdapter(config);
    const body = Buffer.from('{"events":[]}');
    expect(
      a.verifySignature({
        headers: { 'x-line-signature': sign(body) },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects an invalid signature', () => {
    const a = new LineAdapter(config);
    expect(
      a.verifySignature({
        headers: { 'x-line-signature': 'wrongsig' },
        rawBody: Buffer.from('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('parses an inbound text message and captures replyToken', async () => {
    const a = new LineAdapter(config);
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
      rawBody: Buffer.from(''),
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

  it('skips non-message events', async () => {
    const a = new LineAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: Buffer.from(''),
      body: { events: [{ type: 'follow', timestamp: 0, source: {} }] },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('verifyCredentials returns actionable hint when token is empty', async () => {
    const a = new LineAdapter({ channelAccessToken: '', channelSecret: 'x' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('LINE Developers Console');
    }
  });

  it('verifyCredentials returns actionable hint when secret is empty', async () => {
    const a = new LineAdapter({ channelAccessToken: 'x', channelSecret: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Channel secret');
  });
});
