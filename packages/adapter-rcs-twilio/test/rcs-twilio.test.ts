import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyTwilioError,
  createRcsTwilioAdapter,
  mapTwilioStatus,
  toContentTypes,
} from '../src/index.js';

const config = {
  accountSid: 'AC123',
  authToken: 'tok',
  messagingServiceSid: 'MG456',
  apiBase: 'https://api.test.local',
  contentApiBase: 'https://content.test.local',
};

type Call = { url: string; init?: RequestInit };

/** Replays canned responses in order and records every request. */
function mockFetch(responses: Array<{ status?: number; body?: unknown }>) {
  const calls: Call[] = [];
  let i = 0;
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    return {
      status: r.status ?? 200,
      ok: (r.status ?? 200) < 400,
      json: async () => r.body ?? {},
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const formOf = (calls: Call[], i = 0) =>
  Object.fromEntries(new URLSearchParams(calls[i]!.init!.body as string));
const jsonOf = (calls: Call[], i = 0) => JSON.parse(calls[i]!.init!.body as string);

function outbound(content: unknown, metadata?: unknown) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'rcs-twilio' as const,
    account: { channel: 'rcs-twilio' as const, channelAccountId: 'MG456' },
    contact: { channel: 'rcs-twilio' as const, channelUserId: '+919999999999' },
    content,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  } as Parameters<ReturnType<typeof createRcsTwilioAdapter>['send']>[0];
}

describe('content mapping', () => {
  it('maps a card to twilio/card with a text fallback for SMS', () => {
    const types = toContentTypes({
      type: 'card',
      title: 'Jio ₹459',
      text: 'Unlimited 5G and voice',
      mediaRef: { kind: 'url', value: 'https://cdn.example.com/plan.jpg' },
      actions: [{ type: 'url', label: 'Recharge now', url: 'https://jio.com/r' }],
    });

    expect(types).toEqual({
      'twilio/card': {
        title: 'Jio ₹459',
        subtitle: 'Unlimited 5G and voice',
        media: ['https://cdn.example.com/plan.jpg'],
        actions: [{ type: 'URL', title: 'Recharge now', url: 'https://jio.com/r' }],
      },
      // Without this, a fallback to SMS arrives blank.
      'twilio/text': { body: 'Jio ₹459\nUnlimited 5G and voice' },
    });
  });

  it('keeps the link in the text fallback for a cta_url, which SMS cannot button', () => {
    const types = toContentTypes({
      type: 'cta_url',
      text: 'Your receipt is ready.',
      buttonLabel: 'View receipt',
      url: 'https://example.com/r/1',
    }) as Record<string, { body: string }>;

    expect(types['twilio/text']!.body).toBe('Your receipt is ready.\nhttps://example.com/r/1');
  });

  it('truncates suggestion labels and caps the action count', () => {
    const types = toContentTypes({
      type: 'card',
      text: 'pick',
      actions: Array.from({ length: 15 }, (_, i) => ({
        type: 'reply' as const,
        id: `id-${i}`,
        label: 'a label far longer than twenty-five characters',
      })),
    }) as Record<string, { actions: Array<{ title: string; id: string }> }>;

    const actions = types['twilio/card']!.actions;
    expect(actions).toHaveLength(11);
    expect(actions[0]!.title).toHaveLength(25);
    // The id is the postback payload — truncating it would break matching.
    expect(actions[0]!.id).toBe('id-0');
  });

  it('maps reply, url and dial actions to their Twilio kinds', () => {
    const types = toContentTypes({
      type: 'card',
      text: 'x',
      actions: [
        { type: 'reply', id: 'yes', label: 'Yes' },
        { type: 'url', label: 'Open', url: 'https://x.com' },
        { type: 'dial', label: 'Call', phoneNumber: '+15551234567' },
      ],
    }) as Record<string, { actions: Array<Record<string, unknown>> }>;

    expect(types['twilio/card']!.actions).toEqual([
      { type: 'QUICK_REPLY', title: 'Yes', id: 'yes' },
      { type: 'URL', title: 'Open', url: 'https://x.com' },
      { type: 'PHONE_NUMBER', title: 'Call', phone: '+15551234567' },
    ]);
  });

  it('refuses an uploaded media ref, since RCS fetches media by URL', () => {
    expect(
      toContentTypes({ type: 'image', mediaRef: { kind: 'platform-id', value: 'abc' } }),
    ).toBeNull();
  });
});

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('sends plain text with no template at all', async () => {
    const calls = mockFetch([{ body: { sid: 'SM1', status: 'queued' } }]);
    const receipt = await createRcsTwilioAdapter(config).send(
      outbound({ type: 'text', text: 'hello' }),
    );

    expect(receipt.status).toBe('queued');
    expect(receipt.externalId).toBe('SM1');
    expect(receipt.recipientId).toBe('+919999999999');
    expect(calls).toHaveLength(1);

    expect(formOf(calls)).toEqual({
      To: '+919999999999',
      MessagingServiceSid: 'MG456',
      Body: 'hello',
    });
  });

  it('creates a Content Template for a card, then sends by ContentSid', async () => {
    const calls = mockFetch([
      { body: { sid: 'HX789' } },
      { body: { sid: 'SM1', status: 'sent' } },
    ]);

    const receipt = await createRcsTwilioAdapter(config).send(
      outbound({ type: 'card', text: 'Unlimited 5G', actions: [] }),
    );

    expect(receipt.status).toBe('sent');
    expect(calls[0]!.url).toBe('https://content.test.local/v1/Content');
    expect(jsonOf(calls, 0).types['twilio/card']).toBeDefined();
    expect(formOf(calls, 1).ContentSid).toBe('HX789');
    expect(formOf(calls, 1).Body).toBeUndefined();
  });

  it('creates one template for the same card sent twice', async () => {
    const calls = mockFetch([
      { body: { sid: 'HX789' } },
      { body: { sid: 'SM1', status: 'sent' } },
      { body: { sid: 'SM2', status: 'sent' } },
    ]);
    const adapter = createRcsTwilioAdapter(config);

    await adapter.send(outbound({ type: 'card', text: 'same' }));
    await adapter.send(outbound({ type: 'card', text: 'same' }));

    const contentCalls = calls.filter((c) => c.url.includes('/v1/Content'));
    expect(contentCalls).toHaveLength(1);
  });

  it('uses an explicit contentSid and its variables when given', async () => {
    const calls = mockFetch([{ body: { sid: 'SM1', status: 'sent' } }]);
    await createRcsTwilioAdapter(config).send(
      outbound({ type: 'text', text: 'ignored' }, {
        contentSid: 'HXmine',
        contentVariables: { 1: 'Ayush' },
      }),
    );

    expect(calls).toHaveLength(1);
    expect(formOf(calls).ContentSid).toBe('HXmine');
    expect(formOf(calls).ContentVariables).toBe('{"1":"Ayush"}');
  });

  it('refuses rich content when auto-creation is off', async () => {
    const calls = mockFetch([{ body: {} }]);
    const receipt = await createRcsTwilioAdapter({
      ...config,
      autoCreateTemplates: false,
    }).send(outbound({ type: 'card', text: 'x' }));

    expect(receipt.error?.code).toBe('rcs_twilio_content_sid_required');
    expect(receipt.error?.retryable).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it('marks a STOP reply recipient-fatal so it can be suppressed', async () => {
    mockFetch([
      { status: 400, body: { error_code: 21610, error_message: 'Attempt to send to unsubscribed recipient' } },
    ]);
    const receipt = await createRcsTwilioAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.code).toBe('rcs_twilio_21610');
    expect(receipt.error?.permanent).toBe(true);
    expect(receipt.error?.retryable).toBe(false);
  });

  it('does not blame the recipient for a wrong Messaging Service', async () => {
    mockFetch([{ status: 404, body: { error_code: 20404, error_message: 'not found' } }]);
    const receipt = await createRcsTwilioAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.error?.retryable).toBe(false);
    expect(receipt.error?.permanent).toBeUndefined();
  });

  it('never marks a network failure permanent', async () => {
    globalThis.fetch = vi.fn(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const receipt = await createRcsTwilioAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.code).toBe('rcs_twilio_network_error');
    expect(receipt.error?.permanent).toBe(false);
  });
});

describe('inbound', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const req = (body: Record<string, string>) => ({
    headers: {},
    rawBody: new Uint8Array(),
    body,
    query: {},
  });

  it('parses a reply, keeping the Twilio SID for dedup', async () => {
    const messages = await createRcsTwilioAdapter(config).handleWebhook(
      req({ From: '+919999999999', To: 'MG456', MessageSid: 'SM1', Body: 'yes please' }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.externalId).toBe('SM1');
    expect(messages[0]!.content).toEqual({ type: 'text', text: 'yes please' });
    expect(messages[0]!.contact.channelUserId).toBe('+919999999999');
  });

  it('surfaces a suggestion tap as an interaction payload', async () => {
    const messages = await createRcsTwilioAdapter(config).handleWebhook(
      req({
        From: '+919999999999',
        MessageSid: 'SM2',
        Body: 'Recharge now',
        ButtonPayload: 'recharge_459',
      }),
    );

    expect(messages[0]!.interaction?.data).toBe('recharge_459');
  });

  it('types inbound media from its content type rather than assuming image', async () => {
    const messages = await createRcsTwilioAdapter(config).handleWebhook(
      req({
        From: '+91999',
        MessageSid: 'SM3',
        NumMedia: '1',
        MediaUrl0: 'https://api.twilio.com/m/1',
        MediaContentType0: 'video/mp4',
      }),
    );

    expect(messages[0]!.content.type).toBe('video');
  });

  it('ignores a status callback arriving on the same endpoint', async () => {
    const messages = await createRcsTwilioAdapter(config).handleWebhook(
      req({ From: '+91999', MessageSid: 'SM4', MessageStatus: 'delivered' }),
    );
    expect(messages).toEqual([]);
  });
});

describe('parseStatuses', () => {
  it('maps a delivery callback, with the same code namespace as a failed send', () => {
    const receipts = createRcsTwilioAdapter(config).parseStatuses({
      MessageSid: 'SM1',
      MessageStatus: 'undelivered',
      To: '+919999999999',
      ErrorCode: '21610',
      ErrorMessage: 'unsubscribed recipient',
    });

    expect(receipts[0]!.status).toBe('failed');
    expect(receipts[0]!.recipientId).toBe('+919999999999');
    expect(receipts[0]!.error?.code).toBe('rcs_twilio_21610');
    expect(receipts[0]!.error?.permanent).toBe(true);
  });

  it('maps the delivered and read states RCS adds over SMS', () => {
    const adapter = createRcsTwilioAdapter(config);
    expect(adapter.parseStatuses({ MessageSid: 'S', MessageStatus: 'delivered' })[0]!.status).toBe('delivered');
    expect(adapter.parseStatuses({ MessageSid: 'S', MessageStatus: 'read' })[0]!.status).toBe('read');
    expect(adapter.parseStatuses({ MessageSid: 'S', MessageStatus: 'nonsense' })).toEqual([]);
  });

  it('maps every Twilio status the API can return', () => {
    expect(mapTwilioStatus('accepted')).toBe('queued');
    expect(mapTwilioStatus('sending')).toBe('sent');
    expect(mapTwilioStatus('failed')).toBe('failed');
    expect(mapTwilioStatus(undefined)).toBeNull();
  });
});

describe('verifySignature', () => {
  it('refuses an unverifiable webhook unless opted out explicitly', async () => {
    const withoutUrl = createRcsTwilioAdapter(config);
    const req = { headers: {}, rawBody: new Uint8Array(), body: {}, query: {} };

    expect(await withoutUrl.verifySignature(req)).toBe(false);
    expect(
      await createRcsTwilioAdapter({ ...config, allowUnsignedWebhooks: true }).verifySignature(req),
    ).toBe(true);
  });

  it('accepts a correctly signed request and rejects a tampered one', async () => {
    const webhookUrl = 'https://hooks.example.com/rcs';
    const adapter = createRcsTwilioAdapter({ ...config, webhookUrl });
    const body = { From: '+91999', Body: 'hi', MessageSid: 'SM1' };

    // Twilio signs the URL plus every parameter in key order.
    let payload = webhookUrl;
    for (const k of Object.keys(body).sort()) payload += k + body[k as keyof typeof body];
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(config.authToken),
      { name: 'HMAC', hash: 'SHA-1' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(payload)));
    const expected = btoa(String.fromCharCode(...sig));

    expect(
      await adapter.verifySignature({
        headers: { 'x-twilio-signature': expected },
        rawBody: new Uint8Array(),
        body,
        query: {},
      }),
    ).toBe(true);

    expect(
      await adapter.verifySignature({
        headers: { 'x-twilio-signature': expected },
        rawBody: new Uint8Array(),
        body: { ...body, Body: 'tampered' },
        query: {},
      }),
    ).toBe(false);
  });
});

describe('classification', () => {
  it('leaves an unknown code unclassified rather than guessing', () => {
    expect(classifyTwilioError(99999)).toEqual({});
    expect(classifyTwilioError(undefined)).toEqual({});
  });

  it('marks a throttle transient', () => {
    expect(classifyTwilioError(20429)).toEqual({ permanent: false, retryable: true });
  });
});

describe('capabilities', () => {
  it('declares cards, which is the whole point of RCS over SMS', () => {
    const caps = createRcsTwilioAdapter(config).capabilities;
    expect(caps.interactive.cards).toBe(true);
    expect(caps.interactive.buttons).toBe(true);
    expect(caps.interactive.ctaUrl).toBe(true);
  });
});
