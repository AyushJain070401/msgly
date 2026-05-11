import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { MessengerAdapter } from '../src/index.js';

const config = {
  pageAccessToken: 'page-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
};

const sign = (body: Buffer): string =>
  'sha256=' +
  createHmac('sha256', config.appSecret).update(body).digest('hex');

describe('MessengerAdapter', () => {
  it('verifies x-hub-signature-256', () => {
    const a = new MessengerAdapter(config);
    const body = Buffer.from('{"object":"page"}');
    expect(
      a.verifySignature({
        headers: { 'x-hub-signature-256': sign(body) },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects malformed signature header', () => {
    const a = new MessengerAdapter(config);
    expect(
      a.verifySignature({
        headers: { 'x-hub-signature-256': 'md5=foo' },
        rawBody: Buffer.from(''),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('handles webhook GET challenge', () => {
    const a = new MessengerAdapter(config);
    const challenge = a.verifyWebhookChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-token',
      'hub.challenge': '1234',
    });
    expect(challenge).toBe('1234');
  });

  it('rejects challenge with wrong token', () => {
    const a = new MessengerAdapter(config);
    const challenge = a.verifyWebhookChallenge({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '1234',
    });
    expect(challenge).toBeNull();
  });

  it('parses an inbound text message', async () => {
    const a = new MessengerAdapter(config);
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page-id',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user-1' },
              recipient: { id: 'page-id' },
              timestamp: 1700000000000,
              message: { mid: 'mid.123', text: 'hi from messenger' },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: Buffer.from(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('messenger');
    expect(m.contact.channelUserId).toBe('user-1');
    expect((m.content as { text: string }).text).toBe('hi from messenger');
  });

  it('skips echo messages', async () => {
    const a = new MessengerAdapter(config);
    const body = {
      object: 'page',
      entry: [
        {
          id: 'page-id',
          time: 0,
          messaging: [
            {
              sender: { id: 'page-id' },
              recipient: { id: 'user-1' },
              timestamp: 0,
              message: { mid: 'mid.echo', text: 'echo', is_echo: true },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: Buffer.from(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('verifyCredentials gives a Messenger-specific hint when token missing', async () => {
    const a = new MessengerAdapter({
      pageAccessToken: '',
      appSecret: 'x',
      verifyToken: 'y',
    });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Messenger');
  });
});
