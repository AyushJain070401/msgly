import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyCallStatus,
  contentToPlivoXml,
  createPlivoVoiceAdapter,
  escapeXml,
  mapPlivoCallStatus,
} from '../src/index.js';

const config = {
  authId: 'MA123456789',
  authToken: 'tok',
  phoneNumber: '+15551234567',
  apiBase: 'https://plivo.test.local',
};

const req = (body: Record<string, string>, headers: Record<string, string> = {}) => ({
  headers,
  rawBody: new Uint8Array(),
  body,
  query: {},
});

describe('Plivo XML', () => {
  it('escapes text, so an ampersand cannot break the document', () => {
    expect(escapeXml('Tom & Jerry <b>')).toBe('Tom &amp; Jerry &lt;b&gt;');
    const xml = contentToPlivoXml(
      { type: 'text', text: 'Rates & terms' },
      { voice: 'WOMAN', language: 'en-US' },
    );
    expect(xml).toContain('Rates &amp; terms');
  });

  it('speaks text with the configured voice', () => {
    const xml = contentToPlivoXml(
      { type: 'text', text: 'Your order shipped' },
      { voice: 'MAN', language: 'en-GB' },
    );
    expect(xml).toContain('<Speak voice="MAN" language="en-GB">Your order shipped</Speak>');
  });

  it('plays audio from a URL and refuses an uploaded ref', () => {
    expect(
      contentToPlivoXml(
        { type: 'audio', mediaRef: { kind: 'url', value: 'https://cdn.example.com/a.mp3' } },
        { voice: 'WOMAN', language: 'en-US' },
      ),
    ).toContain('<Play>https://cdn.example.com/a.mp3</Play>');

    // Plivo fetches the file itself, so an uploaded id means nothing to it.
    expect(
      contentToPlivoXml(
        { type: 'audio', mediaRef: { kind: 'platform-id', value: 'abc' } },
        { voice: 'WOMAN', language: 'en-US' },
      ),
    ).toBeNull();
  });

  it('turns buttons into keypad digits, because a phone has no screen', () => {
    const xml = contentToPlivoXml(
      {
        type: 'interactive',
        text: 'How can we help?',
        buttons: [
          { id: 'sales', label: 'sales' },
          { id: 'support', label: 'support' },
        ],
      },
      { voice: 'WOMAN', language: 'en-US' },
    );

    expect(xml).toContain('<GetDigits numDigits="1"');
    expect(xml).toContain('Press 1 for sales. Press 2 for support.');
  });

  it('refuses content a phone call cannot carry', () => {
    expect(
      contentToPlivoXml(
        { type: 'image', mediaRef: { kind: 'url', value: 'https://x/a.png' } },
        { voice: 'WOMAN', language: 'en-US' },
      ),
    ).toBeNull();
  });
});

describe('respond', () => {
  it('produces XML inside the webhook request, with no shared state', () => {
    const adapter = createPlivoVoiceAdapter({
      ...config,
      respond: (message) =>
        contentToPlivoXml(
          { type: 'text', text: `Hello ${message.contact.channelUserId}` },
          { voice: 'WOMAN', language: 'en-US' },
        ),
    });

    const a = adapter.getInteractionAck!(req({ CallUUID: 'c1', From: '+1111', To: '+15551234567' }));
    const b = adapter.getInteractionAck!(req({ CallUUID: 'c2', From: '+2222', To: '+15551234567' }));

    // Each caller must hear their own reply, not the previous caller's.
    expect(a).toContain('+1111');
    expect(b).toContain('+2222');
  });

  it('falls through when no responder is configured', () => {
    const adapter = createPlivoVoiceAdapter(config);
    expect(adapter.getInteractionAck!(req({ CallUUID: 'c1', From: '+1111' }))).toBeNull();
  });
});

describe('inbound', () => {
  it('surfaces a keypad press as an interaction', async () => {
    const messages = await createPlivoVoiceAdapter(config).handleWebhook(
      req({ CallUUID: 'c1', From: '+1111', To: '+15551234567', Digits: '2' }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.interaction?.data).toBe('2');
    expect(messages[0]!.content).toEqual({ type: 'text', text: '2' });
    expect(messages[0]!.externalId).toBe('c1');
    expect(messages[0]!.metadata?.callUuid).toBe('c1');
  });

  it('ignores a completed-call callback, which is a receipt not a message', async () => {
    const messages = await createPlivoVoiceAdapter(config).handleWebhook(
      req({ CallUUID: 'c1', From: '+1111', CallStatus: 'completed' }),
    );
    expect(messages).toEqual([]);
  });

  it('ignores a payload with no call on it', async () => {
    expect(await createPlivoVoiceAdapter(config).handleWebhook(req({}))).toEqual([]);
  });
});

describe('parseStatuses', () => {
  it('maps call progress and only suppresses a genuinely failed call', () => {
    const adapter = createPlivoVoiceAdapter(config);

    expect(adapter.parseStatuses({ CallUUID: 'c', CallStatus: 'ringing' })[0]!.status).toBe('sent');
    expect(adapter.parseStatuses({ CallUUID: 'c', CallStatus: 'in-progress' })[0]!.status).toBe('delivered');
    expect(adapter.parseStatuses({ CallUUID: 'c', CallStatus: 'completed' })[0]!.status).toBe('read');

    const failed = adapter.parseStatuses({
      CallUUID: 'c',
      CallStatus: 'failed',
      To: '+1999',
      HangupCause: 'INVALID_NUMBER',
    })[0]!;
    expect(failed.status).toBe('failed');
    expect(failed.recipientId).toBe('+1999');
    expect(failed.error?.code).toBe('plivo_voice_INVALID_NUMBER');
    expect(failed.error?.permanent).toBe(true);
  });

  it('never suppresses on busy or no-answer — the person may answer next time', () => {
    const adapter = createPlivoVoiceAdapter(config);
    for (const status of ['busy', 'no-answer', 'timeout']) {
      const receipt = adapter.parseStatuses({ CallUUID: 'c', CallStatus: status })[0]!;
      expect(receipt.error?.permanent).toBe(false);
      expect(receipt.error?.retryable).toBe(true);
    }
  });

  it('ignores a status it does not recognise', () => {
    expect(createPlivoVoiceAdapter(config).parseStatuses({ CallUUID: 'c', CallStatus: 'x' })).toEqual([]);
    expect(mapPlivoCallStatus(undefined)).toBeNull();
    expect(classifyCallStatus('answered')).toEqual({});
  });
});

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const outbound = (content: unknown, metadata?: unknown) =>
    ({
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'plivo-voice' as const,
      account: { channel: 'plivo-voice' as const, channelAccountId: '+15551234567' },
      contact: { channel: 'plivo-voice' as const, channelUserId: '+1999' },
      content,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    }) as Parameters<ReturnType<typeof createPlivoVoiceAdapter>['send']>[0];

  it('points a live call at a new URL', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { status: 202, ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const receipt = await createPlivoVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }, { callUuid: 'c1', transferUrl: 'https://x/next' }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('c1');
    expect(calls[0]!.url).toContain('/Call/c1/');
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      legs: 'aleg',
      aleg_url: 'https://x/next',
    });
  });

  it('explains that a live call needs a URL, pointing at respond for the common case', async () => {
    const receipt = await createPlivoVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }, { callUuid: 'c1' }),
    );
    expect(receipt.error?.code).toBe('plivo_voice_transfer_url_required');
    expect(receipt.error?.message).toContain('config.respond');
  });

  it('refuses without a call uuid rather than guessing', async () => {
    const receipt = await createPlivoVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.code).toBe('plivo_voice_missing_call_uuid');
    expect(receipt.error?.retryable).toBe(false);
  });

  it('refuses content a call cannot carry', async () => {
    const receipt = await createPlivoVoiceAdapter(config).send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'https://x/a.png' } }, { callUuid: 'c' }),
    );
    expect(receipt.error?.code).toBe('plivo_voice_unsupported_content');
  });
});

describe('verifySignature', () => {
  it('refuses an unverifiable webhook unless opted out explicitly', async () => {
    expect(await createPlivoVoiceAdapter(config).verifySignature(req({}))).toBe(false);
    expect(
      await createPlivoVoiceAdapter({ ...config, allowUnsignedWebhooks: true }).verifySignature(req({})),
    ).toBe(true);
  });

  it('accepts a correct V3 signature and rejects a wrong one', async () => {
    const webhookUrl = 'https://hooks.example.com/voice';
    const nonce = 'abc123';
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.authToken),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${webhookUrl}${nonce}`)),
    );
    const expected = btoa(String.fromCharCode(...sig));

    const adapter = createPlivoVoiceAdapter({ ...config, webhookUrl });
    expect(
      await adapter.verifySignature(
        req({}, { 'x-plivo-signature-v3': expected, 'x-plivo-signature-v3-nonce': nonce }),
      ),
    ).toBe(true);

    // Plivo sends several during key rotation — one match is enough.
    expect(
      await adapter.verifySignature(
        req({}, { 'x-plivo-signature-v3': `other,${expected}`, 'x-plivo-signature-v3-nonce': nonce }),
      ),
    ).toBe(true);

    expect(
      await adapter.verifySignature(
        req({}, { 'x-plivo-signature-v3': expected, 'x-plivo-signature-v3-nonce': 'wrong' }),
      ),
    ).toBe(false);
  });
});

describe('verifyCredentials', () => {
  it('asks for a voice-capable Auth ID before touching the network', async () => {
    const result = await createPlivoVoiceAdapter({ ...config, authId: 'XX1' }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('MA');
  });
});
