import { createSign, generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createSendGridAdapter,
  derToP1363,
  mapSendGridEvent,
  parseAddress,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  apiKey: 'SG.test-key',
  from: 'hello@acme.com',
  fromName: 'Acme',
  apiBase: 'https://api.test.local',
};

const account = { channel: 'sendgrid' as const, channelAccountId: 'hello@acme.com' };
const contact = { channel: 'sendgrid' as const, channelUserId: 'alice@example.com' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Real P-256 keypair, so the ECDSA path exercises actual crypto. */
const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
const publicKeyB64 = publicKey.export({ type: 'spki', format: 'der' }).toString('base64');

/** Node signs ECDSA in DER — exactly the format SendGrid sends. */
function signEvent(timestamp: string, body: string): string {
  const signer = createSign('SHA256');
  signer.update(timestamp + body);
  return signer.sign(privateKey).toString('base64');
}

function mockSend(status = 202, payload: unknown = {}, messageId = 'sg-msg-1') {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status < 400,
      status,
      headers: { get: (h: string) => (h === 'x-message-id' ? messageId : null) },
      json: async () => payload,
    } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createSendGridAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'sendgrid' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe('createSendGridAdapter', () => {
  it('declares the sendgrid channel with attachments off by default', () => {
    const a = createSendGridAdapter(baseConfig);
    expect(a.channel).toBe('sendgrid');
    expect(a.capabilities.media.file).toBe(false);
    expect(
      createSendGridAdapter({ ...baseConfig, attachments: { enabled: true } })
        .capabilities.media.file,
    ).toBe(true);
  });

  it('sends a plain-text email and reads the id from the header', async () => {
    const calls = mockSend();

    const a = createSendGridAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'text', text: 'hello' }, { metadata: { subject: 'Hi' } }),
    );

    // SendGrid returns 202 with an empty body — the id is only in a header.
    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('sg-msg-1');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.personalizations).toEqual([{ to: [{ email: 'alice@example.com' }] }]);
    expect(body.from).toEqual({ email: 'hello@acme.com', name: 'Acme' });
    expect(body.subject).toBe('Hi');
    expect(body.content).toEqual([{ type: 'text/plain', value: 'hello' }]);
  });

  it('sends HTML content when format is html', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter(baseConfig);
    await a.send(outbound({ type: 'text', text: '<b>hi</b>', format: 'html' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.content).toEqual([{ type: 'text/html', value: '<b>hi</b>' }]);
  });

  it('sets threading headers when replying', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter(baseConfig);
    await a.send(
      outbound({ type: 'text', text: 'r' }, { metadata: { messageId: '<o@x.com>' } }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.headers).toEqual({ 'In-Reply-To': '<o@x.com>', References: '<o@x.com>' });
  });

  it('sends base64 attachments when enabled', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter({ ...baseConfig, attachments: { enabled: true } });
    const ref = await a.uploadMedia({
      data: encode('PDF'),
      mimeType: 'application/pdf',
      filename: 'a.pdf',
    });

    await a.send(
      outbound({ type: 'text', text: 'see attached' }, {
        attachments: [{ mediaRef: ref, filename: 'a.pdf', mimeType: 'application/pdf' }],
      }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.attachments[0]).toMatchObject({
      content: btoa('PDF'),
      filename: 'a.pdf',
      type: 'application/pdf',
      disposition: 'attachment',
    });
  });

  it('enforces maxSizeBytes before calling the API', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter({
      ...baseConfig,
      attachments: { enabled: true, maxSizeBytes: 2 },
    });
    const ref = await a.uploadMedia({
      data: encode('too long'),
      mimeType: 'text/plain',
      filename: 'b.txt',
    });

    const receipt = await a.send(
      outbound({ type: 'text', text: 'x' }, {
        attachments: [{ mediaRef: ref, filename: 'b.txt', mimeType: 'text/plain' }],
      }),
    );

    expect(receipt.error?.code).toBe('sendgrid_attachment_error');
    expect(calls).toHaveLength(0);
  });

  it('surfaces an API error', async () => {
    mockSend(403, { errors: [{ message: 'The from address does not match a verified Sender' }] });

    const a = createSendGridAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('sendgrid_403');
    expect(receipt.error?.message).toContain('verified Sender');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    const a = createSendGridAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(receipt.error?.code).toBe('sendgrid_network_error');
  });

  it('parses an Inbound Parse post into a message', async () => {
    const a = createSendGridAdapter({ ...baseConfig, attachments: { enabled: true } });
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        from: 'Alice <alice@example.com>',
        to: 'hello@acme.com',
        subject: 'Question',
        text: 'how do I do X?',
        'attachment-info': JSON.stringify({
          attachment1: { filename: 'doc.pdf', type: 'application/pdf' },
        }),
      },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('how do I do X?');
    expect(m.contact.channelUserId).toBe('alice@example.com');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.metadata?.subject).toBe('Question');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]!.filename).toBe('doc.pdf');
  });

  it('falls back to the HTML body when there is no text part', async () => {
    const a = createSendGridAdapter(baseConfig);
    const [m] = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: { from: 'bob@example.com', html: '<p>hi <b>there</b></p>' },
    });
    expect((m!.content as { text: string }).text).toBe('hi there');
  });

  it('ignores Event Webhook arrays in handleWebhook', async () => {
    const a = createSendGridAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: [{ event: 'delivered', sg_message_id: 'x' }],
    });
    expect(messages).toEqual([]);
  });

  it('parses Event Webhook items into receipts', () => {
    const a = createSendGridAdapter(baseConfig);
    const receipts = a.parseDeliveryEvents({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: [
        { event: 'delivered', sg_message_id: 'm1', email: 'a@x.com', timestamp: 1767261600 },
        { event: 'bounce', sg_message_id: 'm2', email: 'b@x.com', reason: '550 no such user' },
        { event: 'not_a_real_event', sg_message_id: 'm3' },
      ],
    });

    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      externalId: 'm1',
      status: 'delivered',
      recipientId: 'a@x.com',
    });
    expect(receipts[1]!.status).toBe('failed');
    expect(receipts[1]!.error?.message).toBe('550 no such user');
  });

  it('verifies a real ECDSA event signature', async () => {
    const a = createSendGridAdapter({
      ...baseConfig,
      eventWebhookPublicKey: publicKeyB64,
    });
    const body = JSON.stringify([{ event: 'delivered' }]);
    const ts = String(Math.floor(Date.now() / 1000));

    expect(
      await a.verifySignature({
        headers: {
          'x-twilio-email-event-webhook-signature': signEvent(ts, body),
          'x-twilio-email-event-webhook-timestamp': ts,
        },
        rawBody: encode(body),
        body: [],
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects a tampered event body', async () => {
    const a = createSendGridAdapter({
      ...baseConfig,
      eventWebhookPublicKey: publicKeyB64,
    });
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signEvent(ts, '[{"event":"delivered"}]');

    expect(
      await a.verifySignature({
        headers: {
          'x-twilio-email-event-webhook-signature': sig,
          'x-twilio-email-event-webhook-timestamp': ts,
        },
        rawBody: encode('[{"event":"bounce"}]'),
        body: [],
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a stale event timestamp', async () => {
    const a = createSendGridAdapter({
      ...baseConfig,
      eventWebhookPublicKey: publicKeyB64,
    });
    const body = '[]';
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);

    expect(
      await a.verifySignature({
        headers: {
          'x-twilio-email-event-webhook-signature': signEvent(staleTs, body),
          'x-twilio-email-event-webhook-timestamp': staleTs,
        },
        rawBody: encode(body),
        body: [],
        query: {},
      }),
    ).toBe(false);
  });

  it('guards the unsigned Inbound Parse webhook with a token', async () => {
    const a = createSendGridAdapter({ ...baseConfig, inboundToken: 's3cret' });
    const make = (query: Record<string, unknown>) => ({
      headers: {},
      rawBody: encode(''),
      body: {},
      query,
    });

    expect(await a.verifySignature(make({ token: 's3cret' }))).toBe(true);
    expect(await a.verifySignature(make({ token: 'wrong' }))).toBe(false);
    expect(await a.verifySignature(make({}))).toBe(false);
  });

  it('accepts everything when neither guard is configured', async () => {
    const a = createSendGridAdapter(baseConfig);
    expect(
      await a.verifySignature({ headers: {}, rawBody: encode(''), body: {}, query: {} }),
    ).toBe(true);
  });

  it('verifyCredentials rejects a key without the mail.send scope', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ scopes: ['alerts.read'] }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createSendGridAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('mail.send');
  });

  it('verifyCredentials succeeds with a mail.send scope', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ scopes: ['mail.send'] }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createSendGridAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createSendGridAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });
});

describe('derToP1363', () => {
  it('converts a real DER signature to 64 raw bytes', () => {
    const der = Buffer.from(signEvent('1', '{}'), 'base64');
    const raw = derToP1363(new Uint8Array(der));
    expect(raw).not.toBeNull();
    // P-256: r and s are 32 bytes each.
    expect(raw!.length).toBe(64);
  });

  it('left-pads short integers rather than shifting them', () => {
    // r = 0x01 (1 byte), s = 0x02 (1 byte)
    const der = new Uint8Array([0x30, 0x06, 0x02, 0x01, 0x01, 0x02, 0x01, 0x02]);
    const raw = derToP1363(der)!;
    expect(raw[31]).toBe(1);
    expect(raw[63]).toBe(2);
    expect(raw[0]).toBe(0);
  });

  it('returns null for input that is not a DER sequence', () => {
    expect(derToP1363(new Uint8Array([0x02, 0x01, 0x01]))).toBeNull();
  });
});

describe('mapSendGridEvent', () => {
  it('maps event names onto delivery statuses', () => {
    expect(mapSendGridEvent('processed')).toBe('queued');
    expect(mapSendGridEvent('delivered')).toBe('delivered');
    expect(mapSendGridEvent('open')).toBe('read');
    expect(mapSendGridEvent('bounce')).toBe('failed');
    expect(mapSendGridEvent('unknown')).toBeNull();
  });
});

describe('parseAddress', () => {
  it('splits a display name from the address', () => {
    expect(parseAddress('Alice <a@x.com>')).toEqual({
      address: 'a@x.com',
      displayName: 'Alice',
    });
    expect(parseAddress('a@x.com')).toEqual({ address: 'a@x.com' });
  });
});

describe('List-Unsubscribe', () => {
  it('emits one-click headers from adapter config', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter({
      ...baseConfig,
      unsubscribe: { url: 'https://acme.com/u?e={{contact}}' },
    });
    await a.send(outbound({ type: 'text', text: 'campaign' }));

    const headers = JSON.parse(calls[0]!.init!.body as string).headers;
    expect(headers['List-Unsubscribe']).toBe('<https://acme.com/u?e=alice%40example.com>');
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('omits the headers when not configured', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter(baseConfig);
    await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(JSON.parse(calls[0]!.init!.body as string).headers).toBeUndefined();
  });

  it('lets per-message metadata carry a per-recipient token', async () => {
    const calls = mockSend();
    const a = createSendGridAdapter({
      ...baseConfig,
      unsubscribe: { url: 'https://acme.com/generic' },
    });
    await a.send(
      outbound({ type: 'text', text: 'x' }, {
        metadata: { unsubscribeUrl: 'https://acme.com/t/abc123' },
      }),
    );

    expect(JSON.parse(calls[0]!.init!.body as string).headers['List-Unsubscribe']).toBe(
      '<https://acme.com/t/abc123>',
    );
  });
});

describe('bounce classification', () => {
  function receiptFor(item: Record<string, unknown>) {
    return createSendGridAdapter(baseConfig).parseDeliveryEvents({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: [{ sg_message_id: 'm1', email: 'a@x.com', ...item }],
    })[0]!;
  }

  it('treats a hard bounce as permanent', () => {
    expect(receiptFor({ event: 'bounce', type: 'bounce' }).error!.permanent).toBe(true);
    // SendGrid omits `type` on a plain hard bounce.
    expect(receiptFor({ event: 'bounce' }).error!.permanent).toBe(true);
  });

  it('treats a block as transient, not a dead address', () => {
    // SendGrid reports blocks through the same `bounce` event — only `type`
    // separates them, and suppressing a block would drop a good recipient.
    expect(receiptFor({ event: 'bounce', type: 'blocked' }).error!.permanent).toBe(false);
    expect(receiptFor({ event: 'blocked' }).error!.permanent).toBe(false);
    expect(receiptFor({ event: 'deferred' }).error!.permanent).toBe(false);
  });

  it('treats dropped and spamreport as permanent', () => {
    expect(receiptFor({ event: 'dropped' }).error!.permanent).toBe(true);
    expect(receiptFor({ event: 'spamreport' }).error).toMatchObject({
      permanent: true,
      complaint: true,
    });
  });
});
