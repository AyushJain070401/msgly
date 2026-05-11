import { describe, expect, it } from 'vitest';

import { createLineAdapter } from '../src/index.js';

const config = {
  channelAccessToken: 'test-token',
  channelSecret: 'test-secret',
};

const encode = (s: string) => new TextEncoder().encode(s);

async function signLine(body: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.channelSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buffer));
  let binary = '';
  for (let i = 0; i < sig.length; i++) binary += String.fromCharCode(sig[i]!);
  return btoa(binary);
}

describe('createLineAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createLineAdapter(config);
    expect(a.channel).toBe('line');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(false);
  });

  it('verifies a valid signature', async () => {
    const a = createLineAdapter(config);
    const body = encode('{"events":[]}');
    const sig = await signLine(body);
    expect(
      await a.verifySignature({
        headers: { 'x-line-signature': sig },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects an invalid signature', async () => {
    const a = createLineAdapter(config);
    expect(
      await a.verifySignature({
        headers: { 'x-line-signature': 'wrongsig' },
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('parses an inbound text message and captures replyToken', async () => {
    const a = createLineAdapter(config);
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
      rawBody: encode(''),
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
    const a = createLineAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { events: [{ type: 'follow', timestamp: 0, source: {} }] },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('verifyCredentials returns actionable hint when token is empty', async () => {
    const a = createLineAdapter({ channelAccessToken: '', channelSecret: 'x' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('LINE Developers Console');
    }
  });

  it('verifyCredentials returns actionable hint when secret is empty', async () => {
    const a = createLineAdapter({ channelAccessToken: 'x', channelSecret: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Channel secret');
  });
});
