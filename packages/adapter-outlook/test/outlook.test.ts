import { afterEach, describe, expect, it, vi } from 'vitest';

import { createOutlookAdapter } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
  refreshToken: 'rtok',
  emailAddress: 'agent@acme.com',
  clientState: 'shared-secret',
  tokenUrl: 'https://token.test.local/token',
  graphBase: 'https://graph.test.local/v1.0',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('createOutlookAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createOutlookAdapter(baseConfig);
    expect(a.channel).toBe('outlook');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.templates).toBe(false);
  });

  it("echoes Graph's validationToken handshake as text/plain via getInteractionAck", () => {
    const a = createOutlookAdapter(baseConfig);
    const ack = a.getInteractionAck?.({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: { validationToken: 'handshake-xyz' },
    });
    expect(ack).not.toBeNull();
    expect(ack && typeof ack === 'object' ? ack.body : null).toBe('handshake-xyz');
    expect(ack && typeof ack === 'object' ? ack.contentType : null).toBe('text/plain');
  });

  it('returns null from getInteractionAck for normal notifications', () => {
    const a = createOutlookAdapter(baseConfig);
    const ack = a.getInteractionAck?.({
      headers: {},
      rawBody: encode(''),
      body: { value: [{ clientState: 'shared-secret' }] },
      query: {},
    });
    expect(ack).toBeNull();
  });

  it('verifySignature accepts the validation handshake (no body) without fetching', async () => {
    const a = createOutlookAdapter(baseConfig);
    const ok = await a.verifySignature({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: { validationToken: 'handshake' },
    });
    expect(ok).toBe(true);
  });

  it('verifySignature checks clientState on every notification entry', async () => {
    const a = createOutlookAdapter(baseConfig);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: { value: [{ clientState: 'shared-secret', resourceData: { id: 'x' } }] },
        query: {},
      }),
    ).toBe(true);

    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: { value: [{ clientState: 'wrong-secret', resourceData: { id: 'x' } }] },
        query: {},
      }),
    ).toBe(false);

    // Even one bad clientState in a batch fails the whole request.
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {
          value: [
            { clientState: 'shared-secret', resourceData: { id: 'a' } },
            { clientState: 'wrong-secret', resourceData: { id: 'b' } },
          ],
        },
        query: {},
      }),
    ).toBe(false);
  });

  it('fetches the message referenced by the notification and emits inbound', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.endsWith('/me/messages/AAMkAGI')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'AAMkAGI',
            conversationId: 'conv-1',
            internetMessageId: '<orig@example.com>',
            subject: 'Hi',
            receivedDateTime: '2026-05-11T12:00:00Z',
            from: { emailAddress: { name: 'Alice', address: 'alice@example.com' } },
            body: { contentType: 'text', content: 'hello from outlook' },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createOutlookAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {
        value: [
          {
            subscriptionId: 'sub-1',
            clientState: 'shared-secret',
            changeType: 'created',
            resource: "users/agent@acme.com/messages/AAMkAGI",
            resourceData: { id: 'AAMkAGI' },
          },
        ],
      },
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('outlook');
    expect(m.contact.channelUserId).toBe('alice@example.com');
    expect(m.contact.displayName).toBe('Alice');
    expect((m.content as { text: string }).text).toBe('hello from outlook');
    expect(m.metadata?.messageId).toBe('AAMkAGI');
    expect(m.metadata?.conversationId).toBe('conv-1');
    expect(m.metadata?.subject).toBe('Hi');
  });

  it('strips HTML when only an HTML body is available', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/me/messages/AAMkAGI')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'AAMkAGI',
            subject: 'html',
            from: { emailAddress: { address: 'alice@example.com' } },
            body: {
              contentType: 'html',
              content:
                '<html><body><p>hello <b>world</b></p><script>alert(1)</script></body></html>',
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createOutlookAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {
        value: [
          { clientState: 'shared-secret', resourceData: { id: 'AAMkAGI' } },
        ],
      },
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('hello world');
  });

  it('send routes through /reply when metadata.messageId is set', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/reply')) {
        capturedUrl = url;
        capturedBody = JSON.parse((init?.body as string) ?? '{}');
        return { ok: true, status: 202, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createOutlookAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'outlook',
      account: { channel: 'outlook', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'outlook', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'reply body' },
      timestamp: new Date().toISOString(),
      metadata: { messageId: 'AAMkAGI', subject: 'Hi' },
    });

    expect(receipt.status).toBe('sent');
    expect(capturedUrl).toContain('/me/messages/AAMkAGI/reply');
    expect(capturedBody?.comment).toBe('reply body');
  });

  it('send falls back to /sendMail without metadata.messageId', async () => {
    let capturedUrl: string | undefined;
    let capturedBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/sendMail')) {
        capturedUrl = url;
        capturedBody = JSON.parse((init?.body as string) ?? '{}');
        return { ok: true, status: 202, json: async () => ({}) } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createOutlookAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'outlook',
      account: { channel: 'outlook', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'outlook', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'new email' },
      timestamp: new Date().toISOString(),
      metadata: { subject: 'About your inquiry' },
    });

    expect(receipt.status).toBe('sent');
    expect(capturedUrl).toContain('/me/sendMail');
    const msg = (capturedBody?.message ?? {}) as {
      subject?: string;
      body?: { content?: string };
      toRecipients?: Array<{ emailAddress?: { address?: string } }>;
    };
    expect(msg.subject).toBe('About your inquiry');
    expect(msg.body?.content).toBe('new email');
    expect(msg.toRecipients?.[0]?.emailAddress?.address).toBe('alice@example.com');
  });

  it('clientState comparison rejects single-byte mismatches with constant-time semantics', async () => {
    const a = createOutlookAdapter(baseConfig);
    // The real test for constant-time is timing-based; what we can test for
    // is that one-character differences are rejected the same way as wholly
    // different strings (and that empty / wrong-type values fail too).
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: { value: [{ clientState: 'shared-secres' }] }, // last char differs
        query: {},
      }),
    ).toBe(false);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: { value: [{ clientState: '' }] },
        query: {},
      }),
    ).toBe(false);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: { value: [{ clientState: undefined as unknown as string }] },
        query: {},
      }),
    ).toBe(false);
  });

  it('reports no media capability until attachments are enabled', () => {
    expect(createOutlookAdapter(baseConfig).capabilities.media.file).toBe(false);
    const on = createOutlookAdapter({ ...baseConfig, attachments: { enabled: true } });
    expect(on.capabilities.media.file).toBe(true);
  });

  it('sends a fileAttachment array on sendMail when enabled', async () => {
    let sendBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      sendBody = JSON.parse((init?.body as string) ?? '{}');
      return { ok: true, status: 202, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const a = createOutlookAdapter({ ...baseConfig, attachments: { enabled: true } });
    const ref = await a.uploadMedia({
      data: encode('CSV,DATA'),
      mimeType: 'text/csv',
      filename: 'report.csv',
    });

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'outlook',
      account: { channel: 'outlook', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'outlook', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'report attached' },
      attachments: [{ mediaRef: ref, filename: 'report.csv', mimeType: 'text/csv' }],
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('sent');
    const attachments = (sendBody?.message as Record<string, unknown>)
      .attachments as Record<string, unknown>[];
    expect(attachments).toHaveLength(1);
    expect(attachments[0]).toMatchObject({
      '@odata.type': '#microsoft.graph.fileAttachment',
      name: 'report.csv',
      contentType: 'text/csv',
      contentBytes: btoa('CSV,DATA'),
    });
  });

  it('puts attachments in the message sub-object when replying', async () => {
    let replyBody: Record<string, unknown> | undefined;
    let replyUrl = '';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      replyUrl = url;
      replyBody = JSON.parse((init?.body as string) ?? '{}');
      return { ok: true, status: 202, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;

    const a = createOutlookAdapter({ ...baseConfig, attachments: { enabled: true } });
    const ref = await a.uploadMedia({ data: encode('x'), mimeType: 'text/plain' });
    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'outlook',
      account: { channel: 'outlook', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'outlook', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'replying' },
      attachments: [{ mediaRef: ref, filename: 'note.txt', mimeType: 'text/plain' }],
      timestamp: new Date().toISOString(),
      metadata: { messageId: 'graph-msg-1' },
    });

    expect(replyUrl).toContain('/me/messages/graph-msg-1/reply');
    expect(replyBody?.comment).toBe('replying');
    const nested = replyBody?.message as { attachments: unknown[] };
    expect(nested.attachments).toHaveLength(1);
  });

  it('rejects attachments over the Graph 3MB inline limit with an actionable error', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
    }) as Response) as unknown as typeof fetch;

    const a = createOutlookAdapter({ ...baseConfig, attachments: { enabled: true } });
    const ref = await a.uploadMedia({
      data: new Uint8Array(3 * 1024 * 1024 + 1),
      mimeType: 'application/pdf',
      filename: 'huge.pdf',
    });

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'outlook',
      account: { channel: 'outlook', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'outlook', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'big one' },
      attachments: [{ mediaRef: ref, filename: 'huge.pdf', mimeType: 'application/pdf' }],
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('outlook_attachment_error');
    expect(receipt.error?.message).toContain('upload session');
  });

  it('only expands attachments on inbound fetch when enabled', async () => {
    const urls: string[] = [];
    const mockFetch = () =>
      vi.fn().mockImplementation(async (url: string) => {
        if (url === baseConfig.tokenUrl) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
          } as Response;
        }
        urls.push(url);
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'gm-1',
            subject: 'files',
            from: { emailAddress: { address: 'bob@example.com', name: 'Bob' } },
            body: { contentType: 'text', content: 'see attached' },
            hasAttachments: true,
            attachments: [
              {
                id: 'att-1',
                name: 'deck.pptx',
                contentType:
                  'application/vnd.openxmlformats-officedocument.presentationml.presentation',
                size: 4096,
              },
            ],
          }),
        } as Response;
      }) as unknown as typeof fetch;

    const req = {
      headers: {},
      rawBody: encode(''),
      body: {
        value: [
          {
            clientState: 'shared-secret',
            resourceData: { id: 'gm-1' },
          },
        ],
      },
      query: {},
    };

    globalThis.fetch = mockFetch();
    const on = createOutlookAdapter({ ...baseConfig, attachments: { enabled: true } });
    const [withAttachments] = await on.handleWebhook(req);
    expect(urls.some((u) => u.includes('$expand=attachments'))).toBe(true);
    expect(withAttachments!.attachments).toHaveLength(1);
    expect(withAttachments!.attachments![0]!.filename).toBe('deck.pptx');
    expect(withAttachments!.attachments![0]!.mediaRef.value).toBe('gm-1:att-1');

    urls.length = 0;
    globalThis.fetch = mockFetch();
    const off = createOutlookAdapter(baseConfig);
    const [plain] = await off.handleWebhook(req);
    expect(urls.some((u) => u.includes('$expand'))).toBe(false);
    expect(plain!.attachments).toBeUndefined();
  });

  it('verifyCredentials returns hint when clientState is missing', async () => {
    const a = createOutlookAdapter({ ...baseConfig, clientState: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('clientState');
    }
  });
});

describe('List-Unsubscribe', () => {
  function mockSend() {
    const captured: { url?: string; init?: RequestInit } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      captured.url = url;
      captured.init = init;
      return { ok: true, status: 202, json: async () => ({}) } as Response;
    }) as unknown as typeof fetch;
    return captured;
  }

  function outbound(extra: Record<string, unknown> = {}) {
    return {
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'outlook' as const,
      account: { channel: 'outlook' as const, channelAccountId: 'agent@acme.com' },
      contact: { channel: 'outlook' as const, channelUserId: 'alice@example.com' },
      content: { type: 'text' as const, text: 'campaign' },
      timestamp: new Date().toISOString(),
      metadata: { subject: 'Newsletter' },
      ...extra,
    };
  }

  it('switches to the MIME endpoint and sets the headers', async () => {
    const captured = mockSend();
    const a = createOutlookAdapter({
      ...baseConfig,
      unsubscribe: { url: 'https://acme.com/u?e={{contact}}' },
    });
    const receipt = await a.send(outbound());

    expect(receipt.status).toBe('sent');
    // Graph's JSON internetMessageHeaders cannot carry List-Unsubscribe, so
    // the adapter must send raw MIME instead.
    expect(new Headers(captured.init!.headers).get('content-type')).toBe(
      'text/plain',
    );

    const mime = atob(captured.init!.body as string);
    expect(mime).toContain('List-Unsubscribe: <https://acme.com/u?e=alice%40example.com>');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
    expect(mime).toContain('From: agent@acme.com');
    expect(mime).toContain('Subject: Newsletter');
    expect(mime).toContain('campaign');
  });

  it('keeps using the JSON API when unsubscribe is not configured', async () => {
    const captured = mockSend();
    const a = createOutlookAdapter(baseConfig);
    await a.send(outbound());

    const body = JSON.parse(captured.init!.body as string);
    expect(body.message.subject).toBe('Newsletter');
    expect(body.saveToSentItems).toBe(true);
  });

  it('builds multipart MIME when attachments ride along', async () => {
    const captured = mockSend();
    const a = createOutlookAdapter({
      ...baseConfig,
      attachments: { enabled: true },
      unsubscribe: { url: 'https://acme.com/u' },
    });
    const ref = await a.uploadMedia({
      data: encode('PDF'),
      mimeType: 'application/pdf',
      filename: 'a.pdf',
    });
    await a.send(
      outbound({
        attachments: [{ mediaRef: ref, filename: 'a.pdf', mimeType: 'application/pdf' }],
      }),
    );

    const mime = atob(captured.init!.body as string);
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('List-Unsubscribe: <https://acme.com/u>');
    expect(mime).toContain('filename="a.pdf"');
    expect(mime).toContain(btoa('PDF'));
  });

  it('rejects a MIME message over Graph’s 4 MB limit with a clear error', async () => {
    mockSend();
    const a = createOutlookAdapter({
      ...baseConfig,
      attachments: { enabled: true },
      unsubscribe: { url: 'https://acme.com/u' },
    });
    const ref = await a.uploadMedia({
      data: new Uint8Array(4 * 1024 * 1024),
      mimeType: 'application/pdf',
      filename: 'big.pdf',
    });
    const receipt = await a.send(
      outbound({
        attachments: [{ mediaRef: ref, filename: 'big.pdf', mimeType: 'application/pdf' }],
      }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('outlook_mime_too_large');
    expect(receipt.error?.message).toContain('MIME sends');
  });

  it('strips CRLF so an unsubscribe URL cannot inject headers', async () => {
    const captured = mockSend();
    const a = createOutlookAdapter(baseConfig);
    await a.send(
      outbound({
        metadata: {
          subject: 'X',
          unsubscribeUrl: 'https://acme.com/u\r\nBcc: evil@x.com',
        },
      }),
    );

    const mime = atob(captured.init!.body as string);
    expect(mime).not.toMatch(/\r\nBcc: evil@x\.com/);
  });
});
