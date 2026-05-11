import { describe, expect, it } from 'vitest';

import { createMessengerAdapter } from '../src/index.js';

const config = {
  pageAccessToken: 'page-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
};

const encode = (s: string) => new TextEncoder().encode(s);

async function signMeta(body: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buffer));
  let hex = '';
  for (let i = 0; i < sig.length; i++) hex += sig[i]!.toString(16).padStart(2, '0');
  return `sha256=${hex}`;
}

describe('createMessengerAdapter', () => {
  it('verifies x-hub-signature-256', async () => {
    const a = createMessengerAdapter(config);
    const body = encode('{"object":"page"}');
    const sig = await signMeta(body);
    expect(
      await a.verifySignature({
        headers: { 'x-hub-signature-256': sig },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects malformed signature header', async () => {
    const a = createMessengerAdapter(config);
    expect(
      await a.verifySignature({
        headers: { 'x-hub-signature-256': 'md5=foo' },
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('handles webhook GET challenge', () => {
    const a = createMessengerAdapter(config);
    const challenge = a.verifyWebhookChallenge!({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'verify-token',
      'hub.challenge': '1234',
    });
    expect(challenge).toBe('1234');
  });

  it('rejects challenge with wrong token', () => {
    const a = createMessengerAdapter(config);
    const challenge = a.verifyWebhookChallenge!({
      'hub.mode': 'subscribe',
      'hub.verify_token': 'wrong',
      'hub.challenge': '1234',
    });
    expect(challenge).toBeNull();
  });

  it('parses an inbound text message', async () => {
    const a = createMessengerAdapter(config);
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
      rawBody: encode(''),
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
    const a = createMessengerAdapter(config);
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
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('verifyCredentials gives a Messenger-specific hint when token missing', async () => {
    const a = createMessengerAdapter({
      pageAccessToken: '',
      appSecret: 'x',
      verifyToken: 'y',
    });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Messenger');
  });
});
