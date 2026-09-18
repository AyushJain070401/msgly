import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createDialAdapter,
  isPermanentDialError,
  mapDialDeliveryState,
  parseDialSignatureHeader,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const SECRET = 'whsec_test_secret';

const baseConfig = {
  apiKey: 'sk_live_0123456789',
  fromNumber: '+15550001111',
  apiBase: 'https://api.test.local',
};

const account = { channel: 'dial' as const, channelAccountId: '+15550001111' };
const contact = { channel: 'dial' as const, channelUserId: '+15550002222' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Real HMAC-SHA256, so signature tests exercise actual crypto. */
function signPayload(timestamp: string, body: string): string {
  return createHmac('sha256', SECRET).update(`${timestamp}.${body}`).digest('hex');
}

function signedRequest(body: string, ts = String(Math.floor(Date.now() / 1000))) {
  return {
    headers: { 'x-dial-signature': `t=${ts},v1=${signPayload(ts, body)}` },
    rawBody: encode(body),
    body: JSON.parse(body) as unknown,
    query: {},
  };
}

function webhook(payload: unknown, headers: Record<string, string> = {}) {
  const body = JSON.stringify(payload);
  return { headers, rawBody: encode(body), body: payload, query: {} };
}

function mockApi(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createDialAdapter>['send']>[0]['content'],
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'dial' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
  };
}

function body(calls: Array<{ init?: RequestInit }>, i = 0): Record<string, unknown> {
  return JSON.parse(String(calls[i]?.init?.body)) as Record<string, unknown>;
}

describe('createDialAdapter', () => {
  it('declares the dial channel with full media, reactions and typing', () => {
    const a = createDialAdapter(baseConfig);
    expect(a.channel).toBe('dial');
    expect(a.capabilities.media).toEqual({
      image: true,
      video: true,
      audio: true,
      file: true,
    });
    // Both verified against @getdial/sdk's published types rather than assumed.
    expect(a.capabilities.reactions).toBe(true);
    expect(a.capabilities.typing).toBe(true);
    expect(a.capabilities.templates).toBe(false);
  });

  it('defaults to a conservative 10DLC-safe rate limit', () => {
    expect(createDialAdapter(baseConfig).rateLimit).toEqual({ perSecond: 1, burst: 2 });
  });

  it('sends a text message', async () => {
    const calls = mockApi({ message: { id: 'msg_1', deliveryState: 'pending' } }, 201);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(outbound({ type: 'text', text: 'hello' }));

    expect(calls[0]?.url).toBe('https://api.test.local/api/v1/messages');
    expect(body(calls)).toEqual({ to: '+15550002222', fromNumber: '+15550001111', body: 'hello' });
    expect(receipt).toMatchObject({ messageId: 'm-1', externalId: 'msg_1', status: 'queued' });
  });

  it('forwards a configured rail as channel', async () => {
    const calls = mockApi({ message: { id: 'msg_2' } }, 201);
    const a = createDialAdapter({ ...baseConfig, channel: 'imessage' });

    await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(body(calls)['channel']).toBe('imessage');
  });

  it('sends media as mediaUrls with the caption as body', async () => {
    const calls = mockApi({ message: { id: 'msg_3', deliveryState: 'delivered' } }, 201);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.test/a.png' },
        caption: 'look',
      }),
    );

    expect(body(calls)).toMatchObject({
      mediaUrls: ['https://cdn.test/a.png'],
      body: 'look',
    });
    expect(receipt.status).toBe('delivered');
  });

  it('refuses a platform-id media ref without calling the API', async () => {
    const calls = mockApi({}, 200);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(
      outbound({ type: 'file', mediaRef: { kind: 'platform-id', value: 'abc' } }),
    );

    expect(calls).toHaveLength(0);
    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('dial_media_url_required');
    // Decided locally — retrying can never change the outcome.
    expect(receipt.error?.retryable).toBe(false);
  });

  it('surfaces a Dial API error with a namespaced code', async () => {
    mockApi({ error: { code: 'invalid_to', message: 'Not a valid number' } }, 422);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(outbound({ type: 'text', text: 'x' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('dial_invalid_to');
    expect(receipt.error?.message).toBe('Not a valid number');
    // A 4xx cannot succeed on a retry with the same body.
    expect(receipt.error?.retryable).toBe(false);
  });

  it('marks a 429 retryable', async () => {
    mockApi({ error: { code: 'rate_limited', message: 'slow down' } }, 429);
    const a = createDialAdapter(baseConfig);

    expect((await a.send(outbound({ type: 'text', text: 'x' }))).error?.retryable).toBe(true);
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('socket hang up')) as never;
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(outbound({ type: 'text', text: 'x' }));

    expect(receipt.error?.code).toBe('dial_network_error');
    expect(receipt.error?.message).toBe('socket hang up');
  });

  it('rejects unsupported content locally', async () => {
    const calls = mockApi({}, 200);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(
      outbound({ type: 'location', latitude: 1, longitude: 2 }),
    );

    expect(calls).toHaveLength(0);
    expect(receipt.error?.code).toBe('dial_unsupported_content');
  });
});

describe('handleWebhook', () => {
  const inboundEvent = (over: Record<string, unknown> = {}) => ({
    id: 'evt_1',
    object: 'event',
    type: 'message.received',
    version: 1,
    createdAt: '2026-09-16T08:00:00.000Z',
    data: {
      messageId: 'msg_in_1',
      from: '+15550002222',
      to: '+15550001111',
      channel: 'sms',
      body: 'hey',
      media: [],
      source: 'external',
      ...over,
    },
  });

  it('parses an inbound text message', async () => {
    const a = createDialAdapter(baseConfig);
    const [msg] = await a.handleWebhook(webhook(inboundEvent()));

    expect(msg).toMatchObject({
      channel: 'dial',
      direction: 'inbound',
      externalId: 'msg_in_1',
      content: { type: 'text', text: 'hey' },
      // The envelope's own time, not arrival time.
      timestamp: '2026-09-16T08:00:00.000Z',
    });
    expect(msg?.contact.channelUserId).toBe('+15550002222');
    expect(msg?.account.channelAccountId).toBe('+15550001111');
    expect(msg?.metadata).toMatchObject({ dialChannel: 'sms', dialSource: 'external' });
  });

  it('maps inbound media by content type rather than assuming image', async () => {
    const a = createDialAdapter(baseConfig);
    const [msg] = await a.handleWebhook(
      webhook(
        inboundEvent({
          body: 'clip',
          media: [{ id: 'md_1', url: 'https://cdn.test/v.mp4', contentType: 'video/mp4' }],
        }),
      ),
    );

    expect(msg?.content).toMatchObject({
      type: 'video',
      mediaRef: { kind: 'url', value: 'https://cdn.test/v.mp4', mimeType: 'video/mp4' },
      caption: 'clip',
    });
  });

  it('keeps extra attachments instead of dropping them', async () => {
    const a = createDialAdapter(baseConfig);
    const [msg] = await a.handleWebhook(
      webhook(
        inboundEvent({
          media: [
            { url: 'https://cdn.test/1.png', contentType: 'image/png' },
            { url: 'https://cdn.test/2.png', contentType: 'image/png' },
          ],
        }),
      ),
    );

    expect(msg?.metadata?.['dialAdditionalMedia']).toHaveLength(1);
  });

  it('falls back to the configured line when `to` is null on a group message', async () => {
    const a = createDialAdapter(baseConfig);
    // `to` is null exactly when the conversation is a group — reading it as
    // "my number" is the trap Dial's own types warn about.
    const [msg] = await a.handleWebhook(webhook(inboundEvent({ to: null })));

    expect(msg?.account.channelAccountId).toBe('+15550001111');
    expect(msg?.contact.channelUserId).toBe('+15550002222');
  });

  it('preserves an undocumented rail verbatim', async () => {
    const a = createDialAdapter(baseConfig);
    // Inbound WhatsApp currently has no enum value of its own in Dial's types.
    const [msg] = await a.handleWebhook(webhook(inboundEvent({ channel: 'whatsapp' })));

    expect(msg?.metadata?.['dialChannel']).toBe('whatsapp');
  });

  it('prefers the dedup header over the envelope id', async () => {
    const a = createDialAdapter(baseConfig);
    const [msg] = await a.handleWebhook(
      webhook(inboundEvent(), { 'x-dial-event-id': 'evt_header' }),
    );

    expect(msg?.metadata?.['dialEventId']).toBe('evt_header');
  });

  it('ignores status events', async () => {
    const a = createDialAdapter(baseConfig);
    expect(
      await a.handleWebhook(webhook({ type: 'message.status_changed', data: {} })),
    ).toEqual([]);
  });
});

describe('parseStatuses', () => {
  const statusEvent = (over: Record<string, unknown>) => ({
    id: 'evt_2',
    type: 'message.status_changed',
    createdAt: '2026-09-16T08:01:00.000Z',
    data: {
      messageId: 'msg_1',
      phoneNumberId: 'pn_1',
      from: '+15550001111',
      to: '+15550002222',
      channel: 'sms',
      changed: 'delivery',
      deliveryState: 'delivered',
      readState: 'unsupported',
      deliveryError: null,
      ...over,
    },
  });

  it('turns a delivery advance into a receipt', () => {
    const a = createDialAdapter(baseConfig);
    const [r] = a.parseStatuses(webhook(statusEvent({})));

    expect(r).toMatchObject({
      messageId: 'msg_1',
      externalId: 'msg_1',
      status: 'delivered',
      recipientId: '+15550002222',
      timestamp: '2026-09-16T08:01:00.000Z',
    });
  });

  it('reports a read advance as read', () => {
    const a = createDialAdapter(baseConfig);
    const [r] = a.parseStatuses(
      webhook(statusEvent({ changed: 'read', readState: 'read' })),
    );

    expect(r?.status).toBe('read');
  });

  it('classifies a dead recipient as permanent', () => {
    const a = createDialAdapter(baseConfig);
    const [r] = a.parseStatuses(
      webhook(
        statusEvent({ deliveryState: 'failed', deliveryError: 'invalid_destination' }),
      ),
    );

    expect(r?.status).toBe('failed');
    expect(r?.error).toMatchObject({ code: 'dial_invalid_destination', permanent: true });
  });

  it('leaves an unrecognised failure unsuppressed', () => {
    const a = createDialAdapter(baseConfig);
    const [r] = a.parseStatuses(
      webhook(statusEvent({ deliveryState: 'failed', deliveryError: 'carrier_oddity' })),
    );

    // Wrongly suppressing a good number is the worse error.
    expect(r?.error?.permanent).toBeUndefined();
  });

  it('ignores inbound events', () => {
    const a = createDialAdapter(baseConfig);
    expect(a.parseStatuses(webhook({ type: 'message.received', data: {} }))).toEqual([]);
  });
});

describe('verifySignature', () => {
  const secretConfig = { ...baseConfig, webhookSecret: SECRET };

  it('verifies a real HMAC-SHA256 signature', async () => {
    const a = createDialAdapter(secretConfig);
    const raw = JSON.stringify({ type: 'message.received' });

    expect(await a.verifySignature(signedRequest(raw))).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const a = createDialAdapter(secretConfig);
    const ts = String(Math.floor(Date.now() / 1000));

    expect(
      await a.verifySignature({
        headers: { 'x-dial-signature': `t=${ts},v1=${signPayload(ts, '{"a":1}')}` },
        rawBody: encode('{"a":2}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp, bounding replay', async () => {
    const a = createDialAdapter(secretConfig);
    const stale = String(Math.floor(Date.now() / 1000) - 3600);

    expect(await a.verifySignature(signedRequest('{}', stale))).toBe(false);
  });

  it('fails closed on a missing or malformed header', async () => {
    const a = createDialAdapter(secretConfig);
    const req = { rawBody: encode('{}'), body: {}, query: {} };

    expect(await a.verifySignature({ ...req, headers: {} })).toBe(false);
    expect(await a.verifySignature({ ...req, headers: { 'x-dial-signature': 'garbage' } })).toBe(
      false,
    );
    // A timestamp with no v1 is not a signature.
    expect(await a.verifySignature({ ...req, headers: { 'x-dial-signature': 't=123' } })).toBe(
      false,
    );
  });

  it('skips verification when no secret is configured', async () => {
    const a = createDialAdapter(baseConfig);
    expect(
      await a.verifySignature({ headers: {}, rawBody: encode('{}'), body: {}, query: {} }),
    ).toBe(true);
  });
});

describe('reactions and typing', () => {
  it('sends a reaction through the reply endpoint', async () => {
    const calls = mockApi({}, 200);
    const a = createDialAdapter(baseConfig);

    await a.sendReaction?.(contact, 'msg_in_1', '👍');

    expect(calls[0]?.url).toBe('https://api.test.local/api/v1/messages/msg_in_1/reply');
    expect(body(calls)).toEqual({ reaction: '👍' });
  });

  it('refuses an empty reaction rather than sending one', async () => {
    const calls = mockApi({}, 200);
    const a = createDialAdapter(baseConfig);

    // Other channels use "" to mean removal; Dial documents no such form, so
    // guessing would silently send a reaction instead of removing one.
    await expect(a.sendReaction?.(contact, 'msg_in_1', '')).rejects.toThrow(/removal/);
    expect(calls).toHaveLength(0);
  });

  it('sends a typing indicator', async () => {
    const calls = mockApi({}, 200);
    const a = createDialAdapter(baseConfig);

    await a.sendTyping?.(contact);

    expect(calls[0]?.url).toBe('https://api.test.local/api/v1/typing/start');
    expect(body(calls)).toMatchObject({
      toNumber: '+15550002222',
      fromNumber: '+15550001111',
    });
  });
});

describe('verifyCredentials', () => {
  it('succeeds on a healthy key', async () => {
    // The number list now has to contain fromNumber: verifyCredentials checks
    // the number as well as the key, so an empty list means "wrong number".
    mockApi({ phoneNumbers: [{ id: 'pn_1', phone_number: '+15550001111' }] }, 200);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyCredentials()).toEqual({
      ok: true,
      accountInfo: 'Dial (from: +15550001111)',
    });
  });

  it('reports a 401 as unauthorized', async () => {
    mockApi({}, 401);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyCredentials()).toMatchObject({ ok: false, reason: 'unauthorized' });
  });

  it('returns a hint when the key is missing', async () => {
    const a = createDialAdapter({ ...baseConfig, apiKey: '' });
    const res = await a.verifyCredentials();

    expect(res.ok).toBe(false);
    expect(res.ok === false && res.hint).toMatch(/sk_live_/);
  });
});

describe('pure helpers', () => {
  it('maps Dial delivery states onto unified statuses', () => {
    expect(mapDialDeliveryState('pending')).toBe('queued');
    expect(mapDialDeliveryState('delivered')).toBe('delivered');
    expect(mapDialDeliveryState('undelivered')).toBe('failed');
    expect(mapDialDeliveryState('failed')).toBe('failed');
    // This rail reports nothing further — the message still left Dial.
    expect(mapDialDeliveryState('unconfirmed')).toBe('sent');
    expect(mapDialDeliveryState(undefined)).toBe('sent');
  });

  it('parses the signature header and rejects malformed ones', () => {
    expect(parseDialSignatureHeader('t=123,v1=abc')).toEqual({
      timestamp: '123',
      signature: 'abc',
    });
    expect(parseDialSignatureHeader('v1=abc')).toBeNull();
    expect(parseDialSignatureHeader(undefined)).toBeNull();
  });

  it('classifies errors on the recipient axis only', () => {
    expect(isPermanentDialError('invalid_destination')).toBe(true);
    expect(isPermanentDialError('opted_out')).toBe(true);
    expect(isPermanentDialError('rate_limited')).toBe(false);
    expect(isPermanentDialError('who_knows')).toBeUndefined();
    expect(isPermanentDialError(undefined)).toBeUndefined();
  });
});

describe('edge cases', () => {
  it('treats a 2xx with no message id as a failure rather than a silent success', async () => {
    mockApi({ weird: true }, 200);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(outbound({ type: 'text', text: 'x' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('dial_200');
  });

  it('accepts a string-shaped API error', async () => {
    mockApi({ error: 'plain string failure' }, 400);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(outbound({ type: 'text', text: 'x' }));

    expect(receipt.error?.code).toBe('dial_400');
    expect(receipt.error?.message).toBe('plain string failure');
  });

  it('falls back to an HTTP message when the body carries no detail', async () => {
    mockApi({}, 500);
    const a = createDialAdapter(baseConfig);

    const receipt = await a.send(outbound({ type: 'text', text: 'x' }));

    expect(receipt.error?.message).toBe('HTTP 500');
    // 5xx is worth retrying.
    expect(receipt.error?.retryable).toBe(true);
  });

  it('maps audio and unknown content types on inbound media', async () => {
    const a = createDialAdapter(baseConfig);
    const event = (contentType: string) => ({
      type: 'message.received',
      createdAt: '2026-09-16T08:00:00.000Z',
      data: {
        messageId: 'm',
        from: '+15550002222',
        to: '+15550001111',
        media: [{ url: 'https://cdn.test/f', contentType }],
      },
    });

    const [audio] = await a.handleWebhook(webhook(event('audio/mpeg')));
    expect(audio?.content.type).toBe('audio');

    const [pdf] = await a.handleWebhook(webhook(event('application/pdf')));
    expect(pdf?.content.type).toBe('file');

    // No content type at all must not be guessed as an image.
    const [none] = await a.handleWebhook(webhook(event('')));
    expect(none?.content.type).toBe('file');
  });

  it('drops an inbound event with no sender', async () => {
    const a = createDialAdapter(baseConfig);
    expect(
      await a.handleWebhook(webhook({ type: 'message.received', data: { body: 'x' } })),
    ).toEqual([]);
  });

  it('drops a status event with no message id', () => {
    const a = createDialAdapter(baseConfig);
    expect(
      a.parseStatuses(webhook({ type: 'message.status_changed', data: { changed: 'delivery' } })),
    ).toEqual([]);
  });

  it('tolerates an unparsable or empty webhook body', async () => {
    const a = createDialAdapter(baseConfig);
    const empty = { headers: {}, rawBody: encode(''), body: null, query: {} };

    expect(await a.handleWebhook(empty)).toEqual([]);
    expect(a.parseStatuses(empty)).toEqual([]);
  });

  it('reads a repeated header sent as an array', async () => {
    const a = createDialAdapter(baseConfig);
    const payload = {
      type: 'message.received',
      data: { messageId: 'm', from: '+1555', to: '+1666' },
    };
    const [msg] = await a.handleWebhook({
      headers: { 'x-dial-event-id': ['evt_a', 'evt_b'] },
      rawBody: encode(JSON.stringify(payload)),
      body: payload,
      query: {},
    });

    expect(msg?.metadata?.['dialEventId']).toBe('evt_a');
  });

  it('forwards the configured rail on a typing indicator', async () => {
    const calls = mockApi({}, 200);
    const a = createDialAdapter({ ...baseConfig, channel: 'imessage' });

    await a.sendTyping?.(contact);

    expect(body(calls)['channel']).toBe('imessage');
  });

  it('throws when a reaction or typing call is rejected', async () => {
    mockApi({}, 500);
    const a = createDialAdapter(baseConfig);

    await expect(a.sendReaction?.(contact, 'm1', '👍')).rejects.toThrow(/HTTP 500/);
    await expect(a.sendTyping?.(contact)).rejects.toThrow(/HTTP 500/);
  });

  it('reports a network failure from verifyCredentials', async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new Error('dns')) as never;
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyCredentials()).toMatchObject({
      ok: false,
      reason: 'network_error',
    });
  });

  it('refuses uploadMedia instead of inventing an endpoint', async () => {
    const a = createDialAdapter(baseConfig);
    await expect(
      a.uploadMedia({ data: new Uint8Array([1]), mimeType: 'image/png' }),
    ).rejects.toThrow(/no standalone media upload/);
  });

  it('downloads media and preserves the content type', async () => {
    globalThis.fetch = vi.fn().mockResolvedValue({
      ok: true,
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      headers: { get: () => 'image/png' },
    }) as never;
    const a = createDialAdapter(baseConfig);

    const file = await a.downloadMedia({ kind: 'url', value: 'https://cdn.test/a.png' });

    expect(file.mimeType).toBe('image/png');
    expect(new Uint8Array(file.data as Uint8Array)).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('rejects a non-url download ref and a failed fetch', async () => {
    const a = createDialAdapter(baseConfig);
    await expect(
      a.downloadMedia({ kind: 'platform-id', value: 'x' }),
    ).rejects.toThrow(/url ref/);

    globalThis.fetch = vi.fn().mockResolvedValue({ ok: false, status: 404 }) as never;
    await expect(
      a.downloadMedia({ kind: 'url', value: 'https://cdn.test/missing' }),
    ).rejects.toThrow(/HTTP 404/);
  });
});

describe('verifyPhoneNumber', () => {
  it('matches fromNumber by E.164', async () => {
    mockApi({ data: [{ id: 'pn_1', phone_number: '+15550001111' }] }, 200);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyPhoneNumber()).toEqual({
      ok: true,
      status: 'owned',
      phoneNumber: '+15550001111',
    });
  });

  it('matches fromNumber by id and by nickname', async () => {
    mockApi({ data: [{ id: 'pn_1', phone_number: '+15550001111', nickname: 'Support' }] }, 200);

    const byId = createDialAdapter({ ...baseConfig, fromNumber: 'pn_1' });
    expect(await byId.verifyPhoneNumber()).toMatchObject({ status: 'owned' });

    mockApi({ data: [{ id: 'pn_1', phone_number: '+15550001111', nickname: 'Support' }] }, 200);
    const byNick = createDialAdapter({ ...baseConfig, fromNumber: 'Support' });
    expect(await byNick.verifyPhoneNumber()).toMatchObject({ status: 'owned' });
  });

  it('rejects a fromNumber the account does not have, and lists what it does', async () => {
    mockApi({ data: [{ id: 'pn_9', phone_number: '+15559998888' }] }, 200);
    const a = createDialAdapter(baseConfig);
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: false, status: 'not_owned' });
    expect(res.hint).toContain('+15559998888');
  });

  it('treats an unrecognised list shape as inconclusive, not as a wrong number', async () => {
    mockApi({ unexpected: 'shape' }, 200);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: true, status: 'inconclusive' });
  });
});

describe('verifyCredentials number check', () => {
  it('checks the key and the number in a single request', async () => {
    const calls = mockApi({ data: [{ id: 'pn_1', phone_number: '+15550001111' }] }, 200);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyCredentials()).toEqual({
      ok: true,
      accountInfo: 'Dial (from: +15550001111)',
    });
    // The number list answers both questions — fetching it twice would be a
    // wasted round trip on every credential check.
    expect(calls).toHaveLength(1);
  });

  it('fails with the wrong-number hint when the key is fine but the number is not', async () => {
    mockApi({ data: [{ id: 'pn_9', phone_number: '+15559998888' }] }, 200);
    const a = createDialAdapter(baseConfig);
    const res = await a.verifyCredentials();

    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toBe('unauthorized');
      expect(res.hint).toContain('not one of your Dial numbers');
    }
  });

  it('rejects an empty fromNumber before calling the API', async () => {
    const calls = mockApi({ data: [] }, 200);
    const a = createDialAdapter({ ...baseConfig, fromNumber: '   ' });

    expect(await a.verifyCredentials()).toMatchObject({ ok: false, reason: 'unauthorized' });
    expect(calls).toHaveLength(0);
  });
});

describe('number list envelope', () => {
  // Dial's REST reference does not document this envelope, so the matcher
  // accepts the plausible ones rather than betting on a single key.
  for (const key of ['phoneNumbers', 'phone_numbers', 'data', 'numbers', 'entities']) {
    it(`finds the number under "${key}"`, async () => {
      mockApi({ [key]: [{ id: 'pn_1', phone_number: '+15550001111' }] }, 200);
      const a = createDialAdapter(baseConfig);

      expect(await a.verifyPhoneNumber()).toMatchObject({ ok: true, status: 'owned' });
    });
  }

  it('finds the number in a bare array response', async () => {
    mockApi([{ id: 'pn_1', phone_number: '+15550001111' }], 200);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: true, status: 'owned' });
  });

  it('reports not_owned only when a recognised list really lacks the number', async () => {
    mockApi({ phoneNumbers: [{ phone_number: '+15559998888' }] }, 200);
    const a = createDialAdapter(baseConfig);

    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: false, status: 'not_owned' });
  });
});
