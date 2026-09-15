import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyBounceType,
  classifyPostmarkError,
  createPostmarkAdapter,
} from '../src/index.js';

const config = {
  serverToken: 'server-token',
  from: 'Acme <hello@acme.com>',
  apiBase: 'https://postmark.test.local',
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

const bodyOf = (calls: Call[], i = 0) => JSON.parse(calls[i]!.init!.body as string);

const outbound = (content: unknown, extra: Record<string, unknown> = {}) =>
  ({
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'postmark' as const,
    account: { channel: 'postmark' as const, channelAccountId: 'acme' },
    contact: { channel: 'postmark' as const, channelUserId: 'user@example.com' },
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  }) as Parameters<ReturnType<typeof createPostmarkAdapter>['send']>[0];

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('posts an email on the transactional stream by default', async () => {
    const calls = mockFetch({ MessageID: 'pm-1', ErrorCode: 0, SubmittedAt: '2026-01-01T00:00:00Z' });
    const receipt = await createPostmarkAdapter(config).send(
      outbound({ type: 'text', text: 'hello' }, { metadata: { subject: 'Hi' } }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('pm-1');
    expect(receipt.timestamp).toBe('2026-01-01T00:00:00Z');

    expect(calls[0]!.url).toBe('https://postmark.test.local/email');
    expect((calls[0]!.init!.headers as Record<string, string>)['x-postmark-server-token']).toBe(
      'server-token',
    );
    expect(bodyOf(calls)).toMatchObject({
      From: 'Acme <hello@acme.com>',
      To: 'user@example.com',
      Subject: 'Hi',
      TextBody: 'hello',
      MessageStream: 'outbound',
    });
  });

  it('lets a message pick its own stream, for bulk on a broadcast stream', async () => {
    const calls = mockFetch({ MessageID: 'pm-1', ErrorCode: 0 });
    await createPostmarkAdapter({ ...config, messageStream: 'broadcast' }).send(
      outbound({ type: 'text', text: 'hi' }, { metadata: { messageStream: 'newsletters' } }),
    );
    expect(bodyOf(calls).MessageStream).toBe('newsletters');
  });

  it('treats a 200 with a non-zero ErrorCode as a failure', async () => {
    // Postmark answers 200 and puts the real verdict in ErrorCode.
    mockFetch({ ErrorCode: 406, Message: 'You tried to send to a recipient that has been marked as inactive.' });
    const receipt = await createPostmarkAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('postmark_406');
    // Postmark already suppressed them; our list should agree.
    expect(receipt.error?.permanent).toBe(true);
    expect(receipt.error?.retryable).toBe(false);
  });

  it('does not blame the recipient for a bad server token', async () => {
    mockFetch({ ErrorCode: 10, Message: 'Bad or missing API token' }, 401);
    const receipt = await createPostmarkAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.retryable).toBe(false);
    expect(receipt.error?.permanent).toBeUndefined();
  });

  it('marks a rate limit retryable', async () => {
    mockFetch({ ErrorCode: 429, Message: 'rate limited' });
    const receipt = await createPostmarkAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.retryable).toBe(true);
    expect(receipt.error?.permanent).toBe(false);
  });

  it('sets threading headers', async () => {
    const calls = mockFetch({ MessageID: 'pm-1', ErrorCode: 0 });
    await createPostmarkAdapter(config).send(
      outbound({ type: 'text', text: 'r' }, { metadata: { messageId: '<parent@x>' } }),
    );
    expect(bodyOf(calls).Headers).toEqual([
      { Name: 'In-Reply-To', Value: '<parent@x>' },
      { Name: 'References', Value: '<parent@x>' },
    ]);
  });

  it('refuses attachments unless they are enabled', async () => {
    mockFetch({ MessageID: 'pm-1', ErrorCode: 0 });
    const receipt = await createPostmarkAdapter(config).send(
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
    expect(receipt.error?.code).toBe('postmark_attachment_error');
  });

  it('base64-encodes an enabled attachment with its ContentID', async () => {
    const calls = mockFetch({ MessageID: 'pm-1', ErrorCode: 0 });
    await createPostmarkAdapter({ ...config, attachments: { enabled: true } }).send(
      outbound({ type: 'text', text: 'hi' }, {
        attachments: [
          {
            mediaRef: { kind: 'platform-id', value: 'inline:aGk=' },
            filename: 'logo.png',
            mimeType: 'image/png',
            contentId: 'logo',
          },
        ],
      }),
    );
    expect(bodyOf(calls).Attachments).toEqual([
      { Name: 'logo.png', Content: 'aGk=', ContentType: 'image/png', ContentID: 'cid:logo' },
    ]);
  });
});

describe('inbound', () => {
  const req = (body: unknown) => ({
    headers: {},
    rawBody: new Uint8Array(),
    body,
    query: {},
  });

  it('parses an inbound email with its attachments inline', async () => {
    const messages = await createPostmarkAdapter(config).handleWebhook(
      req({
        RecordType: 'Inbound',
        From: 'A User <user@example.com>',
        FromFull: { Email: 'user@example.com', Name: 'A User' },
        OriginalRecipient: 'support@acme.com',
        Subject: 'Help',
        TextBody: 'my order is late',
        MessageID: 'pm-in-1',
        Date: '2026-01-01T00:00:00Z',
        Attachments: [
          { Name: 'invoice.pdf', Content: 'aGk=', ContentType: 'application/pdf', ContentLength: 2 },
        ],
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.externalId).toBe('pm-in-1');
    expect(messages[0]!.contact).toMatchObject({
      channelUserId: 'user@example.com',
      displayName: 'A User',
    });
    // Postmark inlines the bytes, so no fetch is needed to read them back.
    expect(messages[0]!.attachments?.[0]!.mediaRef.value).toBe('inline:aGk=');
    expect(messages[0]!.metadata?.subject).toBe('Help');
  });

  it('prefers the stripped reply over the quoted body', async () => {
    const messages = await createPostmarkAdapter(config).handleWebhook(
      req({
        RecordType: 'Inbound',
        From: 'user@example.com',
        StrippedTextReply: 'just this',
        TextBody: 'just this\n> everything quoted',
      }),
    );
    expect(messages[0]!.content).toEqual({ type: 'text', text: 'just this' });
  });

  it('ignores a bounce arriving on the same endpoint', async () => {
    const messages = await createPostmarkAdapter(config).handleWebhook(
      req({ RecordType: 'Bounce', Type: 'HardBounce', Email: 'gone@example.com' }),
    );
    expect(messages).toEqual([]);
  });
});

describe('parseDeliveryEvents', () => {
  const req = (body: unknown) => ({
    headers: {},
    rawBody: new Uint8Array(),
    body,
    query: {},
  });

  it('suppresses a hard bounce but never a soft one', () => {
    const adapter = createPostmarkAdapter(config);

    const hard = adapter.parseDeliveryEvents(
      req({
        RecordType: 'Bounce',
        Type: 'HardBounce',
        Email: 'gone@example.com',
        MessageID: 'pm-1',
        Description: 'The server was unable to deliver your message',
        BouncedAt: '2026-01-01T00:00:00Z',
      }),
    )[0]!;
    expect(hard.error?.code).toBe('postmark_HardBounce');
    expect(hard.error?.permanent).toBe(true);
    expect(hard.recipientId).toBe('gone@example.com');

    const soft = adapter.parseDeliveryEvents(
      req({ RecordType: 'Bounce', Type: 'SoftBounce', Email: 'full@example.com' }),
    )[0]!;
    // A full mailbox says nothing durable about the address.
    expect(soft.error?.permanent).toBe(false);
    expect(soft.error?.retryable).toBe(true);
  });

  it('flags a spam complaint as a complaint', () => {
    const receipt = createPostmarkAdapter(config).parseDeliveryEvents(
      req({ RecordType: 'SpamComplaint', Email: 'angry@example.com', MessageID: 'pm-2' }),
    )[0]!;
    expect(receipt.error?.complaint).toBe(true);
    expect(receipt.error?.permanent).toBe(true);
  });

  it('maps a delivery', () => {
    const receipt = createPostmarkAdapter(config).parseDeliveryEvents(
      req({ RecordType: 'Delivery', Email: 'ok@example.com', MessageID: 'pm-3', DeliveredAt: '2026-01-01T00:00:00Z' }),
    )[0]!;
    expect(receipt.status).toBe('delivered');
  });

  it('ignores anything that is not a delivery event', () => {
    expect(createPostmarkAdapter(config).parseDeliveryEvents(req({ RecordType: 'Inbound' }))).toEqual([]);
    expect(classifyBounceType(undefined)).toEqual({});
    expect(classifyPostmarkError(undefined)).toEqual({});
  });
});

describe('verifySignature', () => {
  const req = (query: Record<string, string>) => ({
    headers: {},
    rawBody: new Uint8Array(),
    body: {},
    query,
  });

  it('rejects when no token is configured, unless opted out', async () => {
    // Postmark does not sign webhooks at all, so with no token there is
    // genuinely nothing to check.
    expect(await createPostmarkAdapter(config).verifySignature(req({}))).toBe(false);
    expect(
      await createPostmarkAdapter({ ...config, allowUnsignedWebhooks: true }).verifySignature(req({})),
    ).toBe(true);
  });

  it('compares the URL token', async () => {
    const adapter = createPostmarkAdapter({ ...config, webhookToken: 'secret123' });
    expect(await adapter.verifySignature(req({ token: 'secret123' }))).toBe(true);
    expect(await adapter.verifySignature(req({ token: 'secret124' }))).toBe(false);
    expect(await adapter.verifySignature(req({ token: 'short' }))).toBe(false);
    expect(await adapter.verifySignature(req({}))).toBe(false);
  });
});

describe('verifyCredentials', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('points at the Server token when Postmark rejects it', async () => {
    mockFetch({}, 401);
    const result = await createPostmarkAdapter(config).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Account token');
  });

  it('accepts a working server token', async () => {
    mockFetch({ Name: 'Acme Production' });
    const result = await createPostmarkAdapter(config).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('Acme Production');
  });
});
