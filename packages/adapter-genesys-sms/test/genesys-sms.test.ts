import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGenesysSmsAdapter } from '../src/index.js';

const config = {
  clientId: 'test-client-id',
  clientSecret: 'test-client-secret',
  region: 'mypurecloud.com',
  phoneNumber: '+15551234567',
};

const encode = (s: string) => new TextEncoder().encode(s);

function mockTokenFetch(extra?: (url: string, init?: RequestInit) => Response | null) {
  return (async (url: string, init?: RequestInit) => {
    if (String(url).includes('/oauth/token')) {
      return new Response(JSON.stringify({ access_token: 'fake-token', expires_in: 86400 }), {
        status: 200,
      });
    }
    const custom = extra?.(String(url), init);
    if (custom) return custom;
    return new Response(JSON.stringify({}), { status: 200 });
  }) as unknown as typeof fetch;
}

describe('createGenesysSmsAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createGenesysSmsAdapter(config);
    expect(a.channel).toBe('genesys-sms');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(false);
    expect(a.capabilities.templates).toBe(false);
  });

  it('rejects webhooks when no webhookSecret is configured and unverified not allowed', async () => {
    const a = createGenesysSmsAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('allows unverified webhooks when explicitly opted in', async () => {
    const a = createGenesysSmsAdapter({ ...config, allowUnverifiedWebhooks: true });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects when signature header is missing but webhookSecret is set', async () => {
    const a = createGenesysSmsAdapter({ ...config, webhookSecret: 'shh' });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('verifies a correctly signed webhook', async () => {
    const a = createGenesysSmsAdapter({ ...config, webhookSecret: 'shh' });
    const rawBody = encode('{"hello":"world"}');
    const key = await globalThis.crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('shh'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = await globalThis.crypto.subtle.sign('HMAC', key, rawBody);
    const hex = Array.from(new Uint8Array(sig))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');

    expect(
      await a.verifySignature({
        headers: { 'x-genesys-signature': hex },
        rawBody,
        body: { hello: 'world' },
        query: {},
      }),
    ).toBe(true);

    expect(
      await a.verifySignature({
        headers: { 'x-genesys-signature': 'wrong' },
        rawBody,
        body: { hello: 'world' },
        query: {},
      }),
    ).toBe(false);
  });

  it('parses an inbound SMS from a direct event body', async () => {
    const a = createGenesysSmsAdapter(config);
    const body = {
      id: 'msg-123',
      conversationId: 'conv-1',
      fromAddress: { phoneNumber: '+15559876543' },
      toAddress: { phoneNumber: '+15551234567' },
      textBody: 'Hello from Genesys',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('genesys-sms');
    expect(m.externalId).toBe('msg-123');
    expect(m.contact.channelUserId).toBe('+15559876543');
    expect((m.content as { text: string }).text).toBe('Hello from Genesys');
  });

  it('parses an inbound SMS wrapped in a topicName/eventBody envelope', async () => {
    const a = createGenesysSmsAdapter(config);
    const body = {
      topicName: 'v2.conversations.messages.conv-1',
      eventBody: {
        id: 'msg-456',
        fromAddress: { phoneNumber: '+15559876543' },
        textBody: 'wrapped',
      },
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.externalId).toBe('msg-456');
    expect((messages[0]!.content as { text: string }).text).toBe('wrapped');
  });

  it('returns empty array when fromAddress is missing', async () => {
    const a = createGenesysSmsAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { id: 'msg-1' },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('parseStatuses maps delivered/failed states', () => {
    const a = createGenesysSmsAdapter(config);
    const delivered = a.parseStatuses?.({ id: 'msg-1', state: 'Delivered' }) ?? [];
    expect(delivered[0]?.status).toBe('delivered');

    const failed = a.parseStatuses?.({ id: 'msg-2', state: 'Undelivered' }) ?? [];
    expect(failed[0]?.status).toBe('failed');
    expect(failed[0]?.error?.permanent).toBe(true);
  });

  describe('with mocked fetch', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = mockTokenFetch();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('sends a text message successfully', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/conversations/messages')) {
          return new Response(JSON.stringify({ id: 'genesys-msg-1' }), { status: 200 });
        }
        return null;
      });

      const a = createGenesysSmsAdapter(config);
      const receipt = await a.send({
        id: 'local-1',
        direction: 'outbound',
        channel: 'genesys-sms',
        account: { channel: 'genesys-sms', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-sms', channelUserId: '+15559876543' },
        content: { type: 'text', text: 'hi there' },
        timestamp: new Date().toISOString(),
      });

      expect(receipt.status).toBe('sent');
      expect(receipt.externalId).toBe('genesys-msg-1');
    });

    it('returns a failed receipt on API error', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/conversations/messages')) {
          return new Response(JSON.stringify({ message: 'bad request' }), { status: 400 });
        }
        return null;
      });

      const a = createGenesysSmsAdapter(config);
      const receipt = await a.send({
        id: 'local-2',
        direction: 'outbound',
        channel: 'genesys-sms',
        account: { channel: 'genesys-sms', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-sms', channelUserId: '+15559876543' },
        content: { type: 'text', text: 'hi there' },
        timestamp: new Date().toISOString(),
      });

      expect(receipt.status).toBe('failed');
      expect(receipt.error?.message).toBe('bad request');
    });

    it('rejects non-text content', async () => {
      const a = createGenesysSmsAdapter(config);
      const receipt = await a.send({
        id: 'local-3',
        direction: 'outbound',
        channel: 'genesys-sms',
        account: { channel: 'genesys-sms', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-sms', channelUserId: '+15559876543' },
        content: { type: 'image', mediaRef: { kind: 'url', value: 'https://example.com/a.png' } },
        timestamp: new Date().toISOString(),
      });
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('genesys_sms_unsupported_content');
    });

    it('verifyCredentials succeeds when the whoami call resolves', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/users/me')) {
          return new Response(JSON.stringify({ name: 'Test Org' }), { status: 200 });
        }
        return null;
      });
      const a = createGenesysSmsAdapter(config);
      const result = await a.verifyCredentials();
      expect(result.ok).toBe(true);
    });

    it('verifyCredentials fails on 401', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/users/me')) {
          return new Response(JSON.stringify({}), { status: 401 });
        }
        return null;
      });
      const a = createGenesysSmsAdapter(config);
      const result = await a.verifyCredentials();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unauthorized');
    });
  });

  it('verifyCredentials returns hint when clientId is empty', async () => {
    const a = createGenesysSmsAdapter({ ...config, clientId: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('clientId');
  });

  it('verifyCredentials returns hint when region is missing', async () => {
    const a = createGenesysSmsAdapter({ ...config, region: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('region');
  });
});

describe('verifyPhoneNumber', () => {
  it('rejects a malformed number without calling the API', async () => {
    const seen: string[] = [];
    globalThis.fetch = mockTokenFetch((url) => {
      seen.push(url);
      return null;
    });

    const a = createGenesysSmsAdapter({ ...config, phoneNumber: '5551234567' });
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: false, status: 'malformed' });
    expect(seen).toHaveLength(0);
  });

  it('confirms a number held by the org', async () => {
    globalThis.fetch = mockTokenFetch((url) =>
      url.includes('/routing/sms/phonenumbers')
        ? new Response(JSON.stringify({ entities: [{ phoneNumber: '+15551234567' }] }), {
            status: 200,
          })
        : null,
    );

    const a = createGenesysSmsAdapter(config);
    expect(await a.verifyPhoneNumber()).toEqual({
      ok: true,
      status: 'owned',
      phoneNumber: '+15551234567',
    });
  });

  it('rejects a number the org does not hold', async () => {
    globalThis.fetch = mockTokenFetch((url) =>
      url.includes('/routing/sms/phonenumbers')
        ? new Response(JSON.stringify({ entities: [{ phoneNumber: '+15559999999' }] }), {
            status: 200,
          })
        : null,
    );

    const a = createGenesysSmsAdapter(config);
    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: false, status: 'not_owned' });
  });

  it('stays ok when the OAuth client cannot list numbers', async () => {
    globalThis.fetch = mockTokenFetch((url) =>
      url.includes('/routing/sms/phonenumbers')
        ? new Response('{}', { status: 403 })
        : null,
    );

    const a = createGenesysSmsAdapter(config);
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: true, status: 'inconclusive' });
    expect(res.hint).toContain('not permitted');
  });
});
