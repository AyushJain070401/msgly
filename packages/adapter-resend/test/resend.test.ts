import { createHmac } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  computeSvixSignature,
  createResendAdapter,
  mapResendEvent,
  parseAddress,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const WEBHOOK_SECRET = `whsec_${Buffer.from('super-secret-key-bytes').toString('base64')}`;

const baseConfig = {
  apiKey: 're_test_key',
  from: 'Acme <hello@acme.com>',
  apiBase: 'https://api.test.local',
};

const account = { channel: 'resend' as const, channelAccountId: 'hello@acme.com' };
const contact = { channel: 'resend' as const, channelUserId: 'alice@example.com' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

/** Independent Svix signature, so this checks the adapter's implementation. */
function signSvix(secret: string, id: string, ts: string, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest('base64');
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
  content: Parameters<ReturnType<typeof createResendAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'resend' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe('createResendAdapter', () => {
  it('declares the resend channel with attachments off by default', () => {
    const a = createResendAdapter(baseConfig);
    expect(a.channel).toBe('resend');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(false);

    const on = createResendAdapter({ ...baseConfig, attachments: { enabled: true } });
    expect(on.capabilities.media.file).toBe(true);
  });

  it('sends a plain-text email', async () => {
    const calls = mockApi({ id: 'email-1' });

    const a = createResendAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'text', text: 'hello' }, { metadata: { subject: 'Hi there' } }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('email-1');
    expect(calls[0]!.url).toBe('https://api.test.local/emails');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authorization).toBe('Bearer re_test_key');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body).toMatchObject({
      from: 'Acme <hello@acme.com>',
      to: ['alice@example.com'],
      subject: 'Hi there',
      text: 'hello',
    });
    expect(body.html).toBeUndefined();
  });

  it('sends HTML when format is html', async () => {
    const calls = mockApi({ id: 'email-2' });
    const a = createResendAdapter(baseConfig);
    await a.send(outbound({ type: 'text', text: '<b>hi</b>', format: 'html' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.html).toBe('<b>hi</b>');
    expect(body.text).toBeUndefined();
  });

  it('sets threading headers when replying', async () => {
    const calls = mockApi({ id: 'email-3' });
    const a = createResendAdapter(baseConfig);
    await a.send(
      outbound({ type: 'text', text: 'reply' }, { metadata: { messageId: '<orig@x.com>' } }),
    );

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.headers).toEqual({
      'In-Reply-To': '<orig@x.com>',
      References: '<orig@x.com>',
    });
  });

  it('sends base64 attachments when enabled', async () => {
    const calls = mockApi({ id: 'email-4' });
    const a = createResendAdapter({ ...baseConfig, attachments: { enabled: true } });

    const ref = await a.uploadMedia({
      data: encode('PDF-BYTES'),
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
    });
    const receipt = await a.send(
      outbound({ type: 'text', text: 'attached' }, {
        attachments: [{ mediaRef: ref, filename: 'invoice.pdf', mimeType: 'application/pdf' }],
      }),
    );

    expect(receipt.status).toBe('sent');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.attachments).toHaveLength(1);
    expect(body.attachments[0]).toMatchObject({
      filename: 'invoice.pdf',
      content: btoa('PDF-BYTES'),
      content_type: 'application/pdf',
    });
  });

  it('refuses uploadMedia while attachments are disabled', async () => {
    const a = createResendAdapter(baseConfig);
    await expect(
      a.uploadMedia({ data: encode('x'), mimeType: 'text/plain' }),
    ).rejects.toThrow('attachments: { enabled: true }');
  });

  it('enforces maxSizeBytes before calling the API', async () => {
    const calls = mockApi({ id: 'x' });
    const a = createResendAdapter({
      ...baseConfig,
      attachments: { enabled: true, maxSizeBytes: 4 },
    });
    const ref = await a.uploadMedia({
      data: encode('far too long'),
      mimeType: 'text/plain',
      filename: 'big.txt',
    });

    const receipt = await a.send(
      outbound({ type: 'text', text: 'x' }, {
        attachments: [{ mediaRef: ref, filename: 'big.txt', mimeType: 'text/plain' }],
      }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('resend_attachment_error');
    expect(calls).toHaveLength(0);
  });

  it('surfaces an API error as a failed receipt', async () => {
    mockApi({ name: 'validation_error', message: 'from domain is not verified' }, 422);

    const a = createResendAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('resend_validation_error');
    expect(receipt.error?.message).toBe('from domain is not verified');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ENOTFOUND');
    }) as unknown as typeof fetch;

    const a = createResendAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));
    expect(receipt.error?.code).toBe('resend_network_error');
  });

  it('rejects non-text content', async () => {
    const a = createResendAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } }),
    );
    expect(receipt.error?.code).toBe('resend_unsupported_content');
  });

  it('parses an inbound email.received event', async () => {
    const a = createResendAdapter({ ...baseConfig, attachments: { enabled: true } });
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        type: 'email.received',
        created_at: '2026-01-01T10:00:00.000Z',
        data: {
          email_id: 'in-1',
          from: 'Alice <alice@example.com>',
          to: ['hello@acme.com'],
          subject: 'Question',
          text: 'how do I do X?',
          headers: [{ name: 'Message-ID', value: '<abc@example.com>' }],
          attachments: [
            { filename: 'doc.pdf', content_type: 'application/pdf', size: 100 },
          ],
        },
      },
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('resend');
    expect((m.content as { text: string }).text).toBe('how do I do X?');
    expect(m.contact.channelUserId).toBe('alice@example.com');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.metadata?.subject).toBe('Question');
    expect(m.metadata?.messageId).toBe('<abc@example.com>');
    expect(m.attachments).toHaveLength(1);
    expect(m.attachments![0]!.filename).toBe('doc.pdf');
  });

  it('ignores delivery events in handleWebhook', async () => {
    const a = createResendAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: { type: 'email.delivered', data: { email_id: 'e-1' } },
    });
    expect(messages).toEqual([]);
  });

  it('parses delivery events into receipts', () => {
    const a = createResendAdapter(baseConfig);

    const delivered = a.parseDeliveryEvent({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        type: 'email.delivered',
        created_at: '2026-01-01T10:00:00.000Z',
        data: { email_id: 'e-1', to: ['alice@example.com'] },
      },
    });
    expect(delivered).toMatchObject({
      externalId: 'e-1',
      status: 'delivered',
      recipientId: 'alice@example.com',
    });

    const bounced = a.parseDeliveryEvent({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: { type: 'email.bounced', data: { email_id: 'e-2' } },
    });
    expect(bounced?.status).toBe('failed');
    expect(bounced?.error?.code).toBe('email.bounced');

    // Inbound mail is not a delivery event.
    expect(
      a.parseDeliveryEvent({
        headers: {},
        rawBody: encode(''),
        query: {},
        body: { type: 'email.received', data: { email_id: 'e-3' } },
      }),
    ).toBeNull();
  });

  it('verifies a valid Svix signature', async () => {
    const a = createResendAdapter({ ...baseConfig, webhookSecret: WEBHOOK_SECRET });
    const body = JSON.stringify({ type: 'email.delivered' });
    const id = 'msg_123';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(WEBHOOK_SECRET, id, ts, body);

    expect(
      await a.verifySignature({
        headers: {
          'svix-id': id,
          'svix-timestamp': ts,
          'svix-signature': `v1,${sig}`,
        },
        rawBody: encode(body),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects a tampered body', async () => {
    const a = createResendAdapter({ ...baseConfig, webhookSecret: WEBHOOK_SECRET });
    const id = 'msg_123';
    const ts = String(Math.floor(Date.now() / 1000));
    const sig = signSvix(WEBHOOK_SECRET, id, ts, '{"type":"email.delivered"}');

    expect(
      await a.verifySignature({
        headers: { 'svix-id': id, 'svix-timestamp': ts, 'svix-signature': `v1,${sig}` },
        rawBody: encode('{"type":"email.bounced"}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a stale timestamp, bounding replay', async () => {
    const a = createResendAdapter({ ...baseConfig, webhookSecret: WEBHOOK_SECRET });
    const body = '{}';
    const id = 'msg_123';
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    const sig = signSvix(WEBHOOK_SECRET, id, staleTs, body);

    expect(
      await a.verifySignature({
        headers: { 'svix-id': id, 'svix-timestamp': staleTs, 'svix-signature': `v1,${sig}` },
        rawBody: encode(body),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('accepts any of several space-separated signatures during rotation', async () => {
    const a = createResendAdapter({ ...baseConfig, webhookSecret: WEBHOOK_SECRET });
    const body = '{}';
    const id = 'msg_1';
    const ts = String(Math.floor(Date.now() / 1000));
    const valid = signSvix(WEBHOOK_SECRET, id, ts, body);

    expect(
      await a.verifySignature({
        headers: {
          'svix-id': id,
          'svix-timestamp': ts,
          'svix-signature': `v1,othersig v1,${valid}`,
        },
        rawBody: encode(body),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects requests with signature headers missing', async () => {
    const a = createResendAdapter({ ...baseConfig, webhookSecret: WEBHOOK_SECRET });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode('{}'),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('skips verification when no webhook secret is configured', async () => {
    const a = createResendAdapter(baseConfig);
    expect(
      await a.verifySignature({ headers: {}, rawBody: encode('{}'), body: {}, query: {} }),
    ).toBe(true);
  });

  it('verifyCredentials succeeds when the sending domain is verified', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ name: 'acme.com', status: 'verified' }] }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createResendAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
  });

  it('verifyCredentials flags an unverified domain', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ name: 'acme.com', status: 'pending' }] }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createResendAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('pending');
  });

  it('verifyCredentials flags a domain missing from the account', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ data: [{ name: 'other.com', status: 'verified' }] }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createResendAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.hint).toContain('acme.com');
    }
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createResendAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });
});

describe('computeSvixSignature', () => {
  it('matches an independent HMAC implementation', async () => {
    const mine = await computeSvixSignature(WEBHOOK_SECRET, 'id1', '1700000000', '{}');
    expect(mine).toBe(signSvix(WEBHOOK_SECRET, 'id1', '1700000000', '{}'));
  });
});

describe('mapResendEvent', () => {
  it('maps event types onto delivery statuses', () => {
    expect(mapResendEvent('email.sent')).toBe('sent');
    expect(mapResendEvent('email.delivered')).toBe('delivered');
    expect(mapResendEvent('email.opened')).toBe('read');
    expect(mapResendEvent('email.bounced')).toBe('failed');
    expect(mapResendEvent('email.received')).toBeNull();
  });
});

describe('parseAddress', () => {
  it('splits a display name from the address', () => {
    expect(parseAddress('Alice <alice@example.com>')).toEqual({
      address: 'alice@example.com',
      displayName: 'Alice',
    });
    expect(parseAddress('"Acme Support" <s@acme.com>')).toEqual({
      address: 's@acme.com',
      displayName: 'Acme Support',
    });
    expect(parseAddress('bare@example.com')).toEqual({ address: 'bare@example.com' });
  });
});
