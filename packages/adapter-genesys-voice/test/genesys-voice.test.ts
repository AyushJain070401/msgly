import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createGenesysVoiceAdapter } from '../src/index.js';

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

describe('createGenesysVoiceAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createGenesysVoiceAdapter(config);
    expect(a.channel).toBe('genesys-voice');
    expect(a.capabilities.text).toBe(false);
    expect(a.capabilities.media.audio).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(false);
  });

  it('rejects webhooks with no webhookSecret configured', async () => {
    const a = createGenesysVoiceAdapter(config);
    expect(
      await a.verifySignature({ headers: {}, rawBody: encode(''), body: {}, query: {} }),
    ).toBe(false);
  });

  it('allows unverified webhooks when opted in', async () => {
    const a = createGenesysVoiceAdapter({ ...config, allowUnverifiedWebhooks: true });
    expect(
      await a.verifySignature({ headers: {}, rawBody: encode(''), body: {}, query: {} }),
    ).toBe(true);
  });

  it('verifies a correctly signed webhook and rejects a bad one', async () => {
    const a = createGenesysVoiceAdapter({ ...config, webhookSecret: 'shh' });
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
        body: {},
        query: {},
      }),
    ).toBe(true);
    expect(
      await a.verifySignature({
        headers: { 'x-genesys-signature': 'nope' },
        rawBody,
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('parses an inbound call event with DTMF digits', async () => {
    const a = createGenesysVoiceAdapter(config);
    const body = {
      id: 'conv-1',
      participants: [{ purpose: 'customer', address: '+15559876543', state: 'connected', dtmf: '1' }],
    };
    const messages = await a.handleWebhook({ headers: {}, rawBody: encode(''), body, query: {} });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('genesys-voice');
    expect(m.externalId).toBe('conv-1');
    expect(m.contact.channelUserId).toBe('+15559876543');
    expect((m.content as { text: string }).text).toBe('1');
  });

  it('falls back to a [call:state] placeholder with no digits or speech', async () => {
    const a = createGenesysVoiceAdapter(config);
    const body = {
      id: 'conv-2',
      participants: [{ purpose: 'customer', address: '+15559876543', state: 'alerting' }],
    };
    const messages = await a.handleWebhook({ headers: {}, rawBody: encode(''), body, query: {} });
    expect((messages[0]!.content as { text: string }).text).toBe('[call:alerting]');
  });

  it('returns empty array when conversation id is missing', async () => {
    const a = createGenesysVoiceAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { participants: [] },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('parseStatuses maps connected/none states', () => {
    const a = createGenesysVoiceAdapter(config);
    const connected = a.parseStatuses({
      id: 'conv-1',
      participants: [{ purpose: 'customer', state: 'connected' }],
    });
    expect(connected[0]?.status).toBe('delivered');

    const none = a.parseStatuses({
      id: 'conv-2',
      participants: [{ purpose: 'customer', state: 'none' }],
    });
    expect(none[0]?.status).toBe('failed');
  });

  describe('send()', () => {
    it('refuses text content with a clear "not supported" error', async () => {
      const a = createGenesysVoiceAdapter(config);
      const receipt = await a.send({
        id: 'local-1',
        direction: 'outbound',
        channel: 'genesys-voice',
        account: { channel: 'genesys-voice', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-voice', channelUserId: '+15559876543' },
        content: { type: 'text', text: 'hello' },
        timestamp: new Date().toISOString(),
      });
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('genesys_voice_audio_injection_unsupported');
    });

    it('rejects unsupported content types', async () => {
      const a = createGenesysVoiceAdapter(config);
      const receipt = await a.send({
        id: 'local-2',
        direction: 'outbound',
        channel: 'genesys-voice',
        account: { channel: 'genesys-voice', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-voice', channelUserId: '+15559876543' },
        content: { type: 'image', mediaRef: { kind: 'url', value: 'https://example.com/a.png' } },
        timestamp: new Date().toISOString(),
      });
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('genesys_voice_unsupported_content');
    });

    it('rejects audio with a platform-id mediaRef', async () => {
      const a = createGenesysVoiceAdapter(config);
      const receipt = await a.send({
        id: 'local-3',
        direction: 'outbound',
        channel: 'genesys-voice',
        account: { channel: 'genesys-voice', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-voice', channelUserId: '+15559876543' },
        content: { type: 'audio', mediaRef: { kind: 'platform-id', value: 'abc' } },
        timestamp: new Date().toISOString(),
        metadata: { conversationId: 'conv-1' },
      });
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('genesys_voice_unplayable_media');
    });

    it('returns a not-implemented failure for valid audio (honest scoping)', async () => {
      const a = createGenesysVoiceAdapter(config);
      const receipt = await a.send({
        id: 'local-4',
        direction: 'outbound',
        channel: 'genesys-voice',
        account: { channel: 'genesys-voice', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-voice', channelUserId: '+15559876543' },
        content: { type: 'audio', mediaRef: { kind: 'url', value: 'https://example.com/a.wav' } },
        timestamp: new Date().toISOString(),
        metadata: { conversationId: 'conv-1' },
      });
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('genesys_voice_play_not_implemented');
    });

    it('fails when conversationId is missing', async () => {
      const a = createGenesysVoiceAdapter(config);
      const receipt = await a.send({
        id: 'local-5',
        direction: 'outbound',
        channel: 'genesys-voice',
        account: { channel: 'genesys-voice', channelAccountId: '+15551234567' },
        contact: { channel: 'genesys-voice', channelUserId: '+15559876543' },
        content: { type: 'audio', mediaRef: { kind: 'url', value: 'https://example.com/a.wav' } },
        timestamp: new Date().toISOString(),
      });
      expect(receipt.status).toBe('failed');
      expect(receipt.error?.code).toBe('genesys_voice_missing_conversation_id');
    });
  });

  describe('with mocked fetch', () => {
    const originalFetch = globalThis.fetch;

    beforeEach(() => {
      globalThis.fetch = mockTokenFetch();
    });

    afterEach(() => {
      globalThis.fetch = originalFetch;
    });

    it('initiateCall returns a conversationId on success', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/conversations/calls')) {
          return new Response(JSON.stringify({ id: 'conv-9', state: 'dialing' }), { status: 200 });
        }
        return null;
      });
      const a = createGenesysVoiceAdapter(config);
      const result = await a.initiateCall({ to: '+15559876543' });
      expect(result.conversationId).toBe('conv-9');
      expect(result.state).toBe('dialing');
    });

    it('initiateCall throws on API error', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/conversations/calls')) {
          return new Response(JSON.stringify({ message: 'no lines available' }), { status: 500 });
        }
        return null;
      });
      const a = createGenesysVoiceAdapter(config);
      await expect(a.initiateCall({ to: '+15559876543' })).rejects.toThrow(/no lines available/);
    });

    it('endCall resolves on success', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/disconnect')) {
          return new Response('{}', { status: 200 });
        }
        return null;
      });
      const a = createGenesysVoiceAdapter(config);
      await expect(a.endCall('conv-1')).resolves.toBeUndefined();
    });

    it('verifyCredentials succeeds when the whoami call resolves', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/users/me')) {
          return new Response(JSON.stringify({ name: 'Test Org' }), { status: 200 });
        }
        return null;
      });
      const a = createGenesysVoiceAdapter(config);
      const result = await a.verifyCredentials();
      expect(result.ok).toBe(true);
    });

    it('verifyCredentials fails on 403', async () => {
      globalThis.fetch = mockTokenFetch((url) => {
        if (url.includes('/api/v2/users/me')) {
          return new Response(JSON.stringify({}), { status: 403 });
        }
        return null;
      });
      const a = createGenesysVoiceAdapter(config);
      const result = await a.verifyCredentials();
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe('unauthorized');
    });
  });

  it('verifyCredentials returns hint when clientSecret is empty', async () => {
    const a = createGenesysVoiceAdapter({ ...config, clientSecret: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('clientSecret');
  });

  it('verifyCredentials returns hint when phoneNumber is missing', async () => {
    const a = createGenesysVoiceAdapter({ ...config, phoneNumber: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('phoneNumber');
  });
});

describe('verifyPhoneNumber', () => {
  it('rejects a malformed number without calling the API', async () => {
    const seen: string[] = [];
    globalThis.fetch = mockTokenFetch((url) => {
      seen.push(url);
      return null;
    });

    const a = createGenesysVoiceAdapter({ ...config, phoneNumber: '5551234567' });
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: false, status: 'malformed' });
    expect(seen).toHaveLength(0);
  });

  it('confirms a DID assigned to the org', async () => {
    let lookupUrl = '';
    globalThis.fetch = mockTokenFetch((url) => {
      if (url.includes('/telephony/providers/edges/dids')) {
        lookupUrl = url;
        return new Response(JSON.stringify({ entities: [{ phoneNumber: '+15551234567' }] }), {
          status: 200,
        });
      }
      return null;
    });

    const a = createGenesysVoiceAdapter(config);
    expect(await a.verifyPhoneNumber()).toEqual({
      ok: true,
      status: 'owned',
      phoneNumber: '+15551234567',
    });
    // Voice looks at DIDs, not the SMS inventory its sibling uses.
    expect(lookupUrl).toContain('/api/v2/telephony/providers/edges/dids');
  });

  it('matches a DID reported under "number" rather than "phoneNumber"', async () => {
    globalThis.fetch = mockTokenFetch((url) =>
      url.includes('/telephony/providers/edges/dids')
        ? new Response(JSON.stringify({ entities: [{ number: '+15551234567' }] }), { status: 200 })
        : null,
    );

    const a = createGenesysVoiceAdapter(config);
    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: true, status: 'owned' });
  });

  it('rejects a DID the org does not hold', async () => {
    globalThis.fetch = mockTokenFetch((url) =>
      url.includes('/telephony/providers/edges/dids')
        ? new Response(JSON.stringify({ entities: [{ phoneNumber: '+15559999999' }] }), {
            status: 200,
          })
        : null,
    );

    const a = createGenesysVoiceAdapter(config);
    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: false, status: 'not_owned' });
  });

  it('stays ok when the OAuth client cannot list DIDs', async () => {
    globalThis.fetch = mockTokenFetch((url) =>
      url.includes('/telephony/providers/edges/dids')
        ? new Response('{}', { status: 403 })
        : null,
    );

    const a = createGenesysVoiceAdapter(config);
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: true, status: 'inconclusive' });
    expect(res.hint).toContain('not permitted');
  });

  it('fails verifyCredentials when the DID is not on the org', async () => {
    globalThis.fetch = mockTokenFetch((url) => {
      if (url.includes('/telephony/providers/edges/dids')) {
        return new Response(JSON.stringify({ entities: [] }), { status: 200 });
      }
      if (url.includes('/users/me')) {
        return new Response(JSON.stringify({ name: 'Acme Org' }), { status: 200 });
      }
      return null;
    });

    const a = createGenesysVoiceAdapter(config);
    const res = await a.verifyCredentials();

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.hint).toContain('+15551234567');
  });
});
