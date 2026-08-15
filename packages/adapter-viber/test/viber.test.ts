import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { computeViberSignature, createViberAdapter } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  authToken: 'viber-auth-token',
  senderName: 'Acme Support',
  apiBase: 'https://chatapi.test.local',
};

const account = { channel: 'viber' as const, channelAccountId: 'Acme Support' };
const contact = { channel: 'viber' as const, channelUserId: 'user-abc' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Independent HMAC, so the test validates the adapter rather than echoing it. */
function sign(token: string, body: string): string {
  return createHmac('sha256', token).update(body).digest('hex');
}

function mockApi(payload: unknown) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: true, status: 200, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createViberAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'viber' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function webhook(body: unknown, rawBody = JSON.stringify(body)) {
  return { headers: {}, rawBody: encode(rawBody), body, query: {} };
}

describe('createViberAdapter', () => {
  it('declares the viber channel and its capabilities', () => {
    const a = createViberAdapter(baseConfig);
    expect(a.channel).toBe('viber');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
    expect(a.capabilities.media.file).toBe(true);
    // Viber has no voice-note send type in the messages API.
    expect(a.capabilities.media.audio).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(true);
  });

  it('sends a text message with the sender block', async () => {
    const calls = mockApi({ status: 0, status_message: 'ok', message_token: 5551 });

    const a = createViberAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hello' }));

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('5551');
    expect(calls[0]!.url).toBe('https://chatapi.test.local/pa/send_message');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers['X-Viber-Auth-Token']).toBe('viber-auth-token');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({
      receiver: 'user-abc',
      type: 'text',
      text: 'hello',
      sender: { name: 'Acme Support' },
    });
  });

  it('treats a non-zero status as failure despite HTTP 200', async () => {
    // Viber always answers 200 — trusting that would report failures as sent.
    mockApi({ status: 6, status_message: 'receiverNotSubscribed' });

    const a = createViberAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('viber_6');
    expect(receipt.error?.message).toBe('receiverNotSubscribed');
  });

  it('truncates the sender name to Viber’s 28-character cap', async () => {
    const calls = mockApi({ status: 0, message_token: 1 });
    const a = createViberAdapter({
      ...baseConfig,
      senderName: 'A'.repeat(50),
    });
    await a.send(outbound({ type: 'text', text: 'hi' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.sender.name).toHaveLength(28);
  });

  it('sends an image as a picture message', async () => {
    const calls = mockApi({ status: 0, message_token: 2 });
    const a = createViberAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.test/p.jpg' },
        caption: 'look',
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({
      type: 'picture',
      media: 'https://cdn.test/p.jpg',
      text: 'look',
    });
  });

  it('refuses media with a platform-id ref', async () => {
    const calls = mockApi({ status: 0 });
    const a = createViberAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'platform-id', value: 'x' } }),
    );

    expect(receipt.error?.code).toBe('viber_media_url_required');
    expect(calls).toHaveLength(0);
  });

  it('renders interactive buttons as a Viber keyboard, flattening 2D rows', async () => {
    const calls = mockApi({ status: 0, message_token: 3 });
    const a = createViberAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'interactive',
        text: 'Pick one',
        buttons: [
          [{ id: 'yes', label: 'Yes' }],
          [{ id: 'no', label: 'No' }],
        ],
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.type).toBe('text');
    expect(body.keyboard.Type).toBe('keyboard');
    expect(body.keyboard.Buttons).toHaveLength(2);
    expect(body.keyboard.Buttons[0]).toMatchObject({
      ActionType: 'reply',
      ActionBody: 'yes',
      Text: 'Yes',
    });
  });

  it('caps the keyboard at 24 buttons', async () => {
    const calls = mockApi({ status: 0, message_token: 4 });
    const a = createViberAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'interactive',
        text: 'Many',
        buttons: Array.from({ length: 40 }, (_, i) => ({ id: `b${i}`, label: `B${i}` })),
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.keyboard.Buttons).toHaveLength(24);
  });

  it('sends a location', async () => {
    const calls = mockApi({ status: 0, message_token: 5 });
    const a = createViberAdapter(baseConfig);
    await a.send(outbound({ type: 'location', latitude: 12.5, longitude: 77.5 }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({ type: 'location', location: { lat: 12.5, lon: 77.5 } });
  });

  it('passes tracking data through when supplied', async () => {
    const calls = mockApi({ status: 0, message_token: 6 });
    const a = createViberAdapter(baseConfig);
    await a.send(
      outbound({ type: 'text', text: 'hi' }, { metadata: { trackingData: 'order-1' } }),
    );

    expect(JSON.parse(calls[0]!.init!.body as string).tracking_data).toBe('order-1');
  });

  it('rejects unsupported content', async () => {
    const a = createViberAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'template', templateName: 't', language: 'en' }),
    );
    expect(receipt.error?.code).toBe('viber_unsupported_content');
  });

  it('parses an inbound text message', async () => {
    const a = createViberAdapter(baseConfig);
    const messages = await a.handleWebhook(
      webhook({
        event: 'message',
        timestamp: 1767261600000,
        message_token: 9911,
        sender: { id: 'user-abc', name: 'Alice' },
        message: { type: 'text', text: 'hello there' },
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('viber');
    expect((m.content as { text: string }).text).toBe('hello there');
    expect(m.contact.channelUserId).toBe('user-abc');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.externalId).toBe('9911');
    expect(m.timestamp).toBe(new Date(1767261600000).toISOString());
  });

  it('parses inbound picture, file and location messages', async () => {
    const a = createViberAdapter(baseConfig);
    const base = { event: 'message', sender: { id: 'u1' }, message_token: 1 };

    const [pic] = await a.handleWebhook(
      webhook({ ...base, message: { type: 'picture', media: 'https://x/p.jpg' } }),
    );
    expect(pic!.content).toMatchObject({ type: 'image' });

    const [file] = await a.handleWebhook(
      webhook({
        ...base,
        message: { type: 'file', media: 'https://x/d.pdf', file_name: 'd.pdf' },
      }),
    );
    expect(file!.content).toMatchObject({ type: 'file', caption: 'd.pdf' });

    const [loc] = await a.handleWebhook(
      webhook({ ...base, message: { type: 'location', location: { lat: 1, lon: 2 } } }),
    );
    expect(loc!.content).toEqual({ type: 'location', latitude: 1, longitude: 2 });
  });

  it('ignores lifecycle events that are not messages', async () => {
    const a = createViberAdapter(baseConfig);
    for (const event of ['delivered', 'seen', 'subscribed', 'unsubscribed', 'webhook', 'failed']) {
      expect(
        await a.handleWebhook(webhook({ event, user_id: 'u1', message_token: 1 })),
      ).toEqual([]);
    }
  });

  it('verifies a valid signature and rejects a tampered body', async () => {
    const a = createViberAdapter(baseConfig);
    const body = JSON.stringify({ event: 'message' });
    const sig = sign(baseConfig.authToken, body);

    expect(
      await a.verifySignature({
        headers: { 'x-viber-content-signature': sig },
        rawBody: encode(body),
        body: {},
        query: {},
      }),
    ).toBe(true);

    expect(
      await a.verifySignature({
        headers: { 'x-viber-content-signature': sig },
        rawBody: encode('{"event":"tampered"}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a request with no signature header', async () => {
    const a = createViberAdapter(baseConfig);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('computeViberSignature matches an independent HMAC', async () => {
    expect(await computeViberSignature('tok', encode('{"a":1}'))).toBe(
      sign('tok', '{"a":1}'),
    );
  });

  it('setWebhook posts the url and throws with guidance on failure', async () => {
    const calls = mockApi({ status: 0, status_message: 'ok' });
    const a = createViberAdapter(baseConfig);
    await a.setWebhook('https://example.com/webhook/viber', ['message']);

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(calls[0]!.url).toContain('/pa/set_webhook');
    expect(body.url).toBe('https://example.com/webhook/viber');
    expect(body.event_types).toEqual(['message']);

    mockApi({ status: 1, status_message: 'invalid url' });
    await expect(a.setWebhook('http://insecure')).rejects.toThrow('publicly reachable');
  });

  it('removeWebhook clears the url', async () => {
    const calls = mockApi({ status: 0 });
    const a = createViberAdapter(baseConfig);
    await a.removeWebhook();
    expect(JSON.parse(calls[0]!.init!.body as string).url).toBe('');
  });

  it('verifyCredentials reports the account name', async () => {
    mockApi({ status: 0, name: 'Acme PA', uri: 'acmepa' });
    const result = await createViberAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('Acme PA');
  });

  it('verifyCredentials reports a bad token as unauthorized', async () => {
    mockApi({ status: 2, status_message: 'invalid auth token' });
    const result = await createViberAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('admin panel');
    }
  });

  it('verifyCredentials returns a hint when the token is missing', async () => {
    const result = await createViberAdapter({
      ...baseConfig,
      authToken: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('authToken');
  });
});

describe('broadcast', () => {
  it('sends to many subscribers in one call', async () => {
    const calls = mockApi({ status: 0, message_token: 77, failed_list: [] });
    const a = createViberAdapter(baseConfig);
    const receipt = await a.broadcast(['u1', 'u2'], { type: 'text', text: 'Sale' });

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('77');
    expect(calls[0]!.url).toContain('/pa/broadcast_message');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.broadcast_list).toEqual(['u1', 'u2']);
    expect(body.type).toBe('text');
  });

  it('surfaces partially failed recipients for suppression', async () => {
    // Some subscribers block the account — Viber reports them per recipient
    // rather than failing the whole call.
    mockApi({
      status: 0,
      message_token: 78,
      failed_list: [{ receiver: 'u2', status: 6, status_message: 'receiverNotSubscribed' }],
    });

    const receipt = await createViberAdapter(baseConfig).broadcast(['u1', 'u2'], {
      type: 'text',
      text: 'x',
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.metadata?.failed).toEqual([{ id: 'u2', status: 6 }]);
  });

  it('reports failure when every recipient failed', async () => {
    mockApi({
      status: 0,
      failed_list: [{ receiver: 'u1', status: 6 }],
    });
    const receipt = await createViberAdapter(baseConfig).broadcast(['u1'], {
      type: 'text',
      text: 'x',
    });
    expect(receipt.status).toBe('failed');
  });

  it('refuses more than Viber’s 300-receiver limit', async () => {
    const calls = mockApi({ status: 0 });
    const receipt = await createViberAdapter(baseConfig).broadcast(
      Array.from({ length: 301 }, (_, i) => `u${i}`),
      { type: 'text', text: 'x' },
    );

    expect(receipt.error?.code).toBe('viber_broadcast_limit');
    expect(receipt.error?.permanent).toBe(true);
    expect(calls).toHaveLength(0);
  });

  it('rejects an empty recipient list', async () => {
    const receipt = await createViberAdapter(baseConfig).broadcast([], {
      type: 'text',
      text: 'x',
    });
    expect(receipt.error?.code).toBe('viber_no_recipients');
  });
});
