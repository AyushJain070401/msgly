import { afterEach, describe, expect, it, vi } from 'vitest';

import { classifyMailgunEvent, createMailgunAdapter, parseAddress } from '../src/index.js';

const config = {
  apiKey: 'key-abc',
  domain: 'mg.acme.com',
  from: 'Acme <hello@mg.acme.com>',
  apiBase: 'https://mailgun.test.local',
};

type Call = { url: string; init?: RequestInit };

function mockFetch(payload: unknown, status = 200) {
  const calls: Call[] = [];
  globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { status, ok: status < 400, json: async () => payload } as unknown as Response;
  }) as unknown as typeof fetch;
  return calls;
}

const formOf = (calls: Call[], i = 0) => calls[i]!.init!.body as FormData;

const outbound = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'mailgun' as const,
    account: { channel: 'mailgun' as const, channelAccountId: 'mg.acme.com' },
    contact: { channel: 'mailgun' as const, channelUserId: 'user@example.com' },
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  }) as Parameters<ReturnType<typeof createMailgunAdapter>['send']>[0];

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts a text email and strips the angle brackets off the id', async () => {
    const calls = mockFetch({ id: '<20260101.abc@mg.acme.com>', message: 'Queued' });
    const receipt = await createMailgunAdapter(config).send(
      outbound({ type: 'text', text: 'hello' }, { metadata: { subject: 'Hi' } }),
    );

    expect(receipt.status).toBe('sent');
    // Events key on the bare form, so one id has to work across both paths.
    expect(receipt.externalId).toBe('20260101.abc@mg.acme.com');
    expect(receipt.recipientId).toBe('user@example.com');

    expect(calls[0]!.url).toBe('https://mailgun.test.local/v3/mg.acme.com/messages');
    const form = formOf(calls);
    expect(form.get('to')).toBe('user@example.com');
    expect(form.get('subject')).toBe('Hi');
    expect(form.get('text')).toBe('hello');
    expect(form.get('html')).toBeNull();
  });

  it('sends an HTML body when the content says so', async () => {
    const calls = mockFetch({ id: '<a@b>' });
    await createMailgunAdapter(config).send(
      outbound({ type: 'text', text: '<p>hi</p>', format: 'html' }),
    );
    expect(formOf(calls).get('html')).toBe('<p>hi</p>');
    expect(formOf(calls).get('text')).toBeNull();
  });

  it('sets threading headers through the h: prefix', async () => {
    const calls = mockFetch({ id: '<a@b>' });
    await createMailgunAdapter(config).send(
      outbound({ type: 'text', text: 'reply' }, { metadata: { messageId: '<parent@x>' } }),
    );
    expect(formOf(calls).get('h:In-Reply-To')).toBe('<parent@x>');
    expect(formOf(calls).get('h:References')).toBe('<parent@x>');
  });

  it('uses the EU host when the domain lives there', async () => {
    const calls = mockFetch({ id: '<a@b>' });
    await createMailgunAdapter({ ...config, apiBase: undefined, region: 'eu' }).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(calls[0]!.url).toContain('api.eu.mailgun.net');
  });

  it('explains a 404 as a possible region mismatch, not just a missing domain', async () => {
    mockFetch({}, 404);
    const receipt = await createMailgunAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.code).toBe('mailgun_404');
    expect(receipt.error?.message).toContain('region');
    expect(receipt.error?.retryable).toBe(false);
  });

  it('marks a throttle retryable and never suppressible', async () => {
    mockFetch({ message: 'too many' }, 429);
    const receipt = await createMailgunAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.retryable).toBe(true);
    expect(receipt.error?.permanent).toBe(false);
  });

  it('refuses attachments unless they are enabled', async () => {
    mockFetch({ id: '<a@b>' });
    const receipt = await createMailgunAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }, {
        attachments: [
          {
            mediaRef: { kind: 'platform-id', value: 'inline:aGk=' },
            filename: 'a.txt',
            mimeType: 'text/plain',
          },
        ],
      }),
    );
    expect(receipt.error?.code).toBe('mailgun_attachment_error');
    expect(receipt.error?.message).toContain('attachments: { enabled: true }');
  });

  it('attaches an inline image on the inline field so cid references resolve', async () => {
    const calls = mockFetch({ id: '<a@b>' });
    await createMailgunAdapter({ ...config, attachments: { enabled: true } }).send(
      outbound({ type: 'text', text: 'hi' }, {
        attachments: [
          {
            mediaRef: { kind: 'platform-id', value: 'inline:aGk=' },
            filename: 'logo.png',
            mimeType: 'image/png',
            contentId: 'logo',
            inline: true,
          },
        ],
      }),
    );
    expect(formOf(calls).get('inline')).toBeInstanceOf(Blob);
    expect(formOf(calls).get('attachment')).toBeNull();
  });
});

describe('inbound routes', () => {
  const req = (body: Record<string, string>) => ({
    headers: {},
    rawBody: new Uint8Array(),
    body,
    query: {},
  });

  it('parses a route post, keeping Message-Id for dedup', async () => {
    const messages = await createMailgunAdapter(config).handleWebhook(
      req({
        sender: 'user@example.com',
        from: 'A User <user@example.com>',
        recipient: 'support@mg.acme.com',
        subject: 'Help',
        'body-plain': 'my order is late',
        'Message-Id': '<inbound-1@example.com>',
        timestamp: '1700000000',
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.externalId).toBe('inbound-1@example.com');
    expect(messages[0]!.contact).toMatchObject({
      channelUserId: 'user@example.com',
      displayName: 'A User',
    });
    expect(messages[0]!.content).toEqual({ type: 'text', text: 'my order is late' });
    expect(messages[0]!.metadata?.subject).toBe('Help');
  });

  it('prefers the stripped reply over the full quoted body', async () => {
    const messages = await createMailgunAdapter(config).handleWebhook(
      req({
        sender: 'user@example.com',
        'stripped-text': 'just this',
        'body-plain': 'just this\n> everything they quoted',
      }),
    );
    expect(messages[0]!.content).toEqual({ type: 'text', text: 'just this' });
  });

  it('surfaces attachments lazily, by URL rather than bytes', async () => {
    const messages = await createMailgunAdapter(config).handleWebhook(
      req({
        sender: 'user@example.com',
        'body-plain': 'see attached',
        'attachment-count': '1',
        'attachment-1': JSON.stringify({
          url: 'https://storage.mailgun.net/a/1',
          name: 'invoice.pdf',
          'content-type': 'application/pdf',
          size: 1024,
        }),
      }),
    );

    expect(messages[0]!.attachments).toEqual([
      {
        mediaRef: {
          kind: 'url',
          value: 'https://storage.mailgun.net/a/1',
          mimeType: 'application/pdf',
          filename: 'invoice.pdf',
        },
        filename: 'invoice.pdf',
        mimeType: 'application/pdf',
        size: 1024,
      },
    ]);
  });

  it('ignores an event webhook arriving on the same endpoint', async () => {
    const messages = await createMailgunAdapter(config).handleWebhook({
      headers: {},
      rawBody: new Uint8Array(),
      body: { 'event-data': { event: 'delivered' } },
      query: {},
    });
    expect(messages).toEqual([]);
  });

  it('parses a display name out of an address', () => {
    expect(parseAddress('"A User" <a@b.com>')).toEqual({
      address: 'a@b.com',
      displayName: 'A User',
    });
    expect(parseAddress('a@b.com')).toEqual({ address: 'a@b.com' });
  });
});

describe('parseDeliveryEvents', () => {
  const ev = (data: unknown) => ({
    headers: {},
    rawBody: new Uint8Array(),
    body: { 'event-data': data },
    query: {},
  });

  it('separates a dead mailbox from a temporary refusal, as Mailgun does', () => {
    const adapter = createMailgunAdapter(config);

    const permanent = adapter.parseDeliveryEvents(
      ev({
        event: 'failed',
        severity: 'permanent',
        recipient: 'gone@example.com',
        'delivery-status': { message: '550 no such user' },
        message: { headers: { 'message-id': 'abc@mg' } },
      }),
    )[0]!;
    expect(permanent.error?.permanent).toBe(true);
    expect(permanent.error?.code).toBe('mailgun_failed_permanent');
    expect(permanent.recipientId).toBe('gone@example.com');

    const temporary = adapter.parseDeliveryEvents(
      ev({ event: 'failed', severity: 'temporary', recipient: 'busy@example.com' }),
    )[0]!;
    // A full inbox says nothing durable — suppressing here loses a real person.
    expect(temporary.error?.permanent).toBe(false);
    expect(temporary.error?.retryable).toBe(true);
  });

  it('flags a complaint as both permanent and a complaint', () => {
    const receipt = createMailgunAdapter(config).parseDeliveryEvents(
      ev({ event: 'complained', recipient: 'angry@example.com' }),
    )[0]!;
    expect(receipt.error?.complaint).toBe(true);
    expect(receipt.error?.permanent).toBe(true);
  });

  it('maps delivered and engagement events', () => {
    const adapter = createMailgunAdapter(config);
    expect(adapter.parseDeliveryEvents(ev({ event: 'delivered' }))[0]!.status).toBe('delivered');
    expect(adapter.parseDeliveryEvents(ev({ event: 'opened' }))[0]!.status).toBe('read');
    expect(adapter.parseDeliveryEvents(ev({ event: 'unknown-thing' }))).toEqual([]);
  });

  it('leaves an unrecognised event unclassified', () => {
    expect(classifyMailgunEvent(undefined, undefined)).toEqual({});
    expect(classifyMailgunEvent('accepted', undefined)).toEqual({});
  });
});

describe('verifySignature', () => {
  async function sign(signingKey: string, timestamp: string, token: string) {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode(signingKey),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(`${timestamp}${token}`)),
    );
    return Array.from(sig).map((b) => b.toString(16).padStart(2, '0')).join('');
  }

  it('rejects when no signing key is set, unless opted out', async () => {
    const req = { headers: {}, rawBody: new Uint8Array(), body: {}, query: {} };
    expect(await createMailgunAdapter(config).verifySignature(req)).toBe(false);
    expect(
      await createMailgunAdapter({ ...config, allowUnsignedWebhooks: true }).verifySignature(req),
    ).toBe(true);
  });

  it('verifies a nested event signature and a flat route signature alike', async () => {
    const signingKey = 'sign-key';
    const timestamp = String(Math.floor(Date.now() / 1000));
    const token = 'tok123';
    const signature = await sign(signingKey, timestamp, token);
    const adapter = createMailgunAdapter({ ...config, webhookSigningKey: signingKey });

    expect(
      await adapter.verifySignature({
        headers: {},
        rawBody: new Uint8Array(),
        body: { signature: { timestamp, token, signature } },
        query: {},
      }),
    ).toBe(true);

    expect(
      await adapter.verifySignature({
        headers: {},
        rawBody: new Uint8Array(),
        body: { timestamp, token, signature },
        query: {},
      }),
    ).toBe(true);

    // Flip the last hex digit to something it definitely is not. Replacing it
    // with a fixed character would leave the signature untouched whenever it
    // already ended in that character — a 1-in-16 flake, since the signature
    // changes with the timestamp on every run.
    const tampered = signature.slice(0, -1) + (signature.endsWith('0') ? '1' : '0');
    expect(tampered).not.toBe(signature);

    expect(
      await adapter.verifySignature({
        headers: {},
        rawBody: new Uint8Array(),
        body: { timestamp, token, signature: tampered },
        query: {},
      }),
    ).toBe(false);
  });

  it('rejects a replayed request outside the tolerance window', async () => {
    const signingKey = 'sign-key';
    const old = String(Math.floor(Date.now() / 1000) - 10_000);
    const signature = await sign(signingKey, old, 'tok');

    expect(
      await createMailgunAdapter({ ...config, webhookSigningKey: signingKey }).verifySignature({
        headers: {},
        rawBody: new Uint8Array(),
        body: { timestamp: old, token: 'tok', signature },
        query: {},
      }),
    ).toBe(false);
  });
});

describe('verifyCredentials', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('names the region when a domain is not found on this host', async () => {
    mockFetch({}, 404);
    const result = await createMailgunAdapter(config).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.hint).toContain('EU');
    }
  });

  it('refuses a domain that has not finished DNS verification', async () => {
    mockFetch({ domain: { name: 'mg.acme.com', state: 'unverified' } });
    const result = await createMailgunAdapter(config).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('DNS');
  });

  it('accepts an active domain', async () => {
    mockFetch({ domain: { name: 'mg.acme.com', state: 'active' } });
    expect((await createMailgunAdapter(config).verifyCredentials()).ok).toBe(true);
  });
});
