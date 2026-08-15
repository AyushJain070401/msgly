import { afterEach, describe, expect, it, vi } from 'vitest';

import { createGmailAdapter } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function strToB64url(s: string): string {
  return bytesToB64url(encode(s));
}

const baseConfig = {
  clientId: 'cid',
  clientSecret: 'csec',
  refreshToken: 'rtok',
  emailAddress: 'agent@acme.com',
  apiBase: 'https://api.test.local',
  tokenUrl: 'https://token.test.local/token',
  pushAuth: { kind: 'token' as const, token: 'shh' },
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('createGmailAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createGmailAdapter(baseConfig);
    expect(a.channel).toBe('gmail');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.templates).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(false);
  });

  it("token-mode verifySignature accepts query.token, rejects mismatch", async () => {
    const a = createGmailAdapter(baseConfig);
    const okReq = {
      headers: {},
      rawBody: encode(''),
      body: {},
      query: { token: 'shh' },
    };
    expect(await a.verifySignature(okReq)).toBe(true);

    const badReq = { ...okReq, query: { token: 'wrong' } };
    expect(await a.verifySignature(badReq)).toBe(false);
  });

  it("'none' mode short-circuits verifySignature for dev", async () => {
    const a = createGmailAdapter({ ...baseConfig, pushAuth: { kind: 'none' } });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('parses a Pub/Sub notification, fetches new messages, emits inbound', async () => {
    // Mock the Gmail API: token refresh → history.list → messages.get
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (typeof url !== 'string') throw new Error('non-string url');

      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/gmail/v1/users/me/messages?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'msg-1' }] }),
        } as Response;
      }
      if (url.includes('/gmail/v1/users/me/messages/msg-1')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg-1',
            threadId: 'thread-1',
            internalDate: '1700000000000',
            payload: {
              mimeType: 'text/plain',
              headers: [
                { name: 'From', value: '"Alice" <alice@example.com>' },
                { name: 'To', value: 'agent@acme.com' },
                { name: 'Subject', value: 'Hello agent' },
                { name: 'Message-ID', value: '<abc@example.com>' },
              ],
              body: { data: strToB64url('hi from email') },
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createGmailAdapter(baseConfig);
    const pubsubData = strToB64url(
      JSON.stringify({ emailAddress: 'agent@acme.com', historyId: '99999' }),
    );

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { message: { data: pubsubData } },
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('gmail');
    expect((m.content as { text: string }).text).toBe('hi from email');
    expect(m.contact.channelUserId).toBe('alice@example.com');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.metadata?.threadId).toBe('thread-1');
    expect(m.metadata?.messageId).toBe('<abc@example.com>');
    expect(m.metadata?.subject).toBe('Hello agent');
    expect(m.externalId).toBe('msg-1');
  });

  it('extracts plain-text body when MIME parts are nested', async () => {
    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/gmail/v1/users/me/messages?')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ messages: [{ id: 'msg-2' }] }),
        } as Response;
      }
      if (url.includes('/gmail/v1/users/me/messages/msg-2')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({
            id: 'msg-2',
            payload: {
              mimeType: 'multipart/alternative',
              headers: [
                { name: 'From', value: 'bob@example.com' },
                { name: 'Subject', value: 'multipart' },
              ],
              parts: [
                {
                  mimeType: 'text/html',
                  body: { data: strToB64url('<p>html version</p>') },
                },
                {
                  mimeType: 'text/plain',
                  body: { data: strToB64url('plain version') },
                },
              ],
            },
          }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createGmailAdapter(baseConfig);
    const pubsubData = strToB64url(
      JSON.stringify({ emailAddress: 'agent@acme.com', historyId: '999' }),
    );
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { message: { data: pubsubData } },
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('plain version');
  });

  it('returns no messages for an empty Pub/Sub body', async () => {
    const a = createGmailAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('send constructs a reply that goes to messages.send with threadId and In-Reply-To', async () => {
    let capturedSendUrl: string | undefined;
    let capturedSendBody: Record<string, unknown> | undefined;

    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/gmail/v1/users/me/messages/send')) {
        capturedSendUrl = url;
        capturedSendBody = JSON.parse((init?.body as string) ?? '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'sent-id-1' }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createGmailAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'gmail',
      account: { channel: 'gmail', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'gmail', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'hello back' },
      timestamp: new Date().toISOString(),
      metadata: {
        threadId: 'thread-1',
        messageId: '<orig@example.com>',
        subject: 'Hello agent',
      },
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('sent-id-1');
    expect(capturedSendUrl).toContain('/gmail/v1/users/me/messages/send');
    expect(capturedSendBody?.threadId).toBe('thread-1');

    // Decode the raw email and verify headers.
    const raw = capturedSendBody?.raw as string;
    expect(typeof raw).toBe('string');
    const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded).toContain('From: agent@acme.com');
    expect(decoded).toContain('To: alice@example.com');
    expect(decoded).toContain('Subject: Re: Hello agent');
    expect(decoded).toContain('In-Reply-To: <orig@example.com>');
    expect(decoded).toContain('hello back');
  });

  it('send rejects non-text content with a clear error', async () => {
    const a = createGmailAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'gmail',
      account: { channel: 'gmail', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'gmail', channelUserId: 'alice@example.com' },
      content: {
        type: 'image',
        mediaRef: { kind: 'url', value: 'http://example.com/x.png' },
      },
      timestamp: new Date().toISOString(),
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('gmail_unsupported_content');
  });

  it('strips CRLF from header values to prevent injection', async () => {
    let capturedSendBody: Record<string, unknown> | undefined;
    const fetchMock = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      if (url.includes('/gmail/v1/users/me/messages/send')) {
        capturedSendBody = JSON.parse((init?.body as string) ?? '{}');
        return {
          ok: true,
          status: 200,
          json: async () => ({ id: 'sent-id-1' }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createGmailAdapter(baseConfig);

    // Adversarial metadata: imagine an attacker-controlled subject / refs.
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'gmail',
      account: { channel: 'gmail', channelAccountId: 'agent@acme.com' },
      contact: {
        channel: 'gmail',
        channelUserId: 'victim@example.com\r\nBcc: leak@evil.com',
      },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
      metadata: {
        subject: 'Hello\r\nX-Injected: yes',
        messageId: '<orig@example.com>\r\nReply-To: attacker@evil.com',
      },
    });

    expect(receipt.status).toBe('sent');
    const raw = capturedSendBody?.raw as string;
    const decoded = atob(raw.replace(/-/g, '+').replace(/_/g, '/'));

    // Security property: the injected payloads must NOT appear as header
    // lines of their own (i.e. preceded by CRLF). They land inline in the
    // value of whatever field they were injected into, which makes them
    // invalid header-value content but harmless.
    expect(decoded).not.toMatch(/\r\nBcc:/);
    expect(decoded).not.toMatch(/\r\nX-Injected:/);
    expect(decoded).not.toMatch(/\r\nReply-To:/);

    // The sanitized values are concatenated onto the original header line.
    expect(decoded).toContain('To: victim@example.comBcc: leak@evil.com\r\n');
    expect(decoded).toContain('Subject: Re: HelloX-Injected: yes\r\n');

    // No header line should ever contain a literal CR or LF inside it.
    const headerSection = decoded.split('\r\n\r\n')[0]!;
    for (const line of headerSection.split('\r\n')) {
      expect(line).not.toMatch(/[\r\n]/);
    }
  });

  it('surfaces inbound attachments as lazy references only when enabled', async () => {
    const payload = {
      id: 'msg-7',
      payload: {
        mimeType: 'multipart/mixed',
        headers: [
          { name: 'From', value: 'bob@example.com' },
          { name: 'Subject', value: 'here you go' },
        ],
        parts: [
          { mimeType: 'text/plain', body: { data: strToB64url('see attached') } },
          {
            mimeType: 'application/pdf',
            headers: [
              { name: 'Content-Disposition', value: 'attachment; filename="deck.pdf"' },
            ],
            body: { attachmentId: 'att-77', size: 2048 },
          },
        ],
      },
    };

    const mockFetch = () =>
      vi.fn().mockImplementation(async (url: string) => {
        if (url === baseConfig.tokenUrl) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
          } as Response;
        }
        if (url.includes('/gmail/v1/users/me/messages?')) {
          return {
            ok: true,
            status: 200,
            json: async () => ({ messages: [{ id: 'msg-7' }] }),
          } as Response;
        }
        return { ok: true, status: 200, json: async () => payload } as Response;
      }) as unknown as typeof fetch;

    const req = {
      headers: {},
      rawBody: encode(''),
      body: {
        message: {
          data: strToB64url(
            JSON.stringify({ emailAddress: 'agent@acme.com', historyId: '99999' }),
          ),
        },
      },
      query: {},
    };

    globalThis.fetch = mockFetch();
    const on = createGmailAdapter({ ...baseConfig, attachments: { enabled: true } });
    const [withAttachments] = await on.handleWebhook(req);
    expect(withAttachments!.attachments).toHaveLength(1);
    const att = withAttachments!.attachments![0]!;
    expect(att.filename).toBe('deck.pdf');
    expect(att.mimeType).toBe('application/pdf');
    expect(att.size).toBe(2048);
    // Lazy: the reference is present, the bytes were never fetched.
    expect(att.mediaRef).toEqual({
      kind: 'platform-id',
      value: 'msg-7:att-77',
      mimeType: 'application/pdf',
      filename: 'deck.pdf',
    });

    globalThis.fetch = mockFetch();
    const off = createGmailAdapter(baseConfig);
    const [plain] = await off.handleWebhook(req);
    expect(plain!.attachments).toBeUndefined();
    expect((plain!.content as { text: string }).text).toBe('see attached');
  });

  it('reports no media capability until attachments are enabled', () => {
    expect(createGmailAdapter(baseConfig).capabilities.media.file).toBe(false);
    const on = createGmailAdapter({ ...baseConfig, attachments: { enabled: true } });
    expect(on.capabilities.media.file).toBe(true);
    expect(on.capabilities.media.image).toBe(true);
  });

  it('sends a multipart email with an attachment when enabled', async () => {
    let capturedSendBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      capturedSendBody = JSON.parse((init?.body as string) ?? '{}');
      return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }) } as Response;
    }) as unknown as typeof fetch;

    const a = createGmailAdapter({ ...baseConfig, attachments: { enabled: true } });
    const ref = await a.uploadMedia({
      data: encode('PDF-BYTES'),
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
    });

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'gmail',
      account: { channel: 'gmail', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'gmail', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'invoice attached' },
      attachments: [
        { mediaRef: ref, filename: 'invoice.pdf', mimeType: 'application/pdf' },
      ],
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('sent');
    const decoded = atob((capturedSendBody?.raw as string).replace(/-/g, '+').replace(/_/g, '/'));
    expect(decoded).toContain('Content-Type: multipart/mixed; boundary=');
    expect(decoded).toContain('Content-Disposition: attachment; filename="invoice.pdf"');
    expect(decoded).toContain('Content-Transfer-Encoding: base64');
    expect(decoded).toContain('invoice attached');
    expect(decoded).toContain(btoa('PDF-BYTES'));

    // The boundary must actually delimit, and be closed.
    const boundary = /boundary="([^"]+)"/.exec(decoded)![1]!;
    expect(decoded).toContain(`--${boundary}--`);
    expect(decoded.split(`--${boundary}`).length).toBe(4); // 2 parts + preamble + closer
  });

  it('rejects an attachment over maxSizeBytes before calling the API', async () => {
    const fetchMock = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
    }) as Response);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createGmailAdapter({
      ...baseConfig,
      attachments: { enabled: true, maxSizeBytes: 4 },
    });
    const ref = await a.uploadMedia({
      data: encode('way too many bytes'),
      mimeType: 'text/plain',
      filename: 'big.txt',
    });

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'gmail',
      account: { channel: 'gmail', channelAccountId: 'agent@acme.com' },
      contact: { channel: 'gmail', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'here' },
      attachments: [{ mediaRef: ref, filename: 'big.txt', mimeType: 'text/plain' }],
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('gmail_attachment_error');
    expect(receipt.error?.message).toContain('over the 4 byte limit');
    expect(fetchMock).not.toHaveBeenCalledWith(
      expect.stringContaining('/messages/send'),
      expect.anything(),
    );
  });

  it('uploadMedia refuses to work while attachments are disabled', async () => {
    const a = createGmailAdapter(baseConfig);
    await expect(
      a.uploadMedia({ data: encode('x'), mimeType: 'text/plain' }),
    ).rejects.toThrow('attachments: { enabled: true }');
  });

  it('downloadMedia fetches bytes for a "<messageId>:<attachmentId>" reference', async () => {
    let capturedUrl = '';
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url === baseConfig.tokenUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      capturedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({ data: strToB64url('REPORT') }),
      } as Response;
    }) as unknown as typeof fetch;

    const a = createGmailAdapter({ ...baseConfig, attachments: { enabled: true } });
    const file = await a.downloadMedia({
      kind: 'platform-id',
      value: 'msg-9:att-3',
      mimeType: 'text/csv',
      filename: 'report.csv',
    });

    expect(capturedUrl).toContain('/messages/msg-9/attachments/att-3');
    expect(new TextDecoder().decode(file.data as Uint8Array)).toBe('REPORT');
    expect(file.filename).toBe('report.csv');
  });

  it('verifyCredentials returns hint when refreshToken is empty', async () => {
    const a = createGmailAdapter({ ...baseConfig, refreshToken: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('refreshToken');
    }
  });
});

describe('List-Unsubscribe', () => {
  function mockSend() {
    const captured: { body?: Record<string, unknown> } = {};
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/token')) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ access_token: 'at-1', expires_in: 3600 }),
        } as Response;
      }
      captured.body = JSON.parse((init?.body as string) ?? '{}');
      return { ok: true, status: 200, json: async () => ({ id: 'sent-1' }) } as Response;
    }) as unknown as typeof fetch;
    return captured;
  }

  const decode = (raw: string) => atob(raw.replace(/-/g, '+').replace(/_/g, '/'));

  function outbound(extra: Record<string, unknown> = {}) {
    return {
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'gmail' as const,
      account: { channel: 'gmail' as const, channelAccountId: 'agent@acme.com' },
      contact: { channel: 'gmail' as const, channelUserId: 'alice@example.com' },
      content: { type: 'text' as const, text: 'campaign' },
      timestamp: new Date().toISOString(),
      ...extra,
    };
  }

  it('adds one-click headers to the MIME message', async () => {
    const captured = mockSend();
    const a = createGmailAdapter({
      ...baseConfig,
      unsubscribe: { url: 'https://acme.com/u?e={{contact}}', mailto: 'unsub@acme.com' },
    });
    await a.send(outbound());

    const decoded = decode(captured.body!.raw as string);
    expect(decoded).toContain(
      'List-Unsubscribe: <mailto:unsub@acme.com>, <https://acme.com/u?e=alice%40example.com>',
    );
    expect(decoded).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('adds the headers to the multipart builder too', async () => {
    const captured = mockSend();
    const a = createGmailAdapter({
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

    const decoded = decode(captured.body!.raw as string);
    expect(decoded).toContain('List-Unsubscribe: <https://acme.com/u>');
    expect(decoded).toContain('multipart/mixed');
  });

  it('omits the headers when not configured', async () => {
    const captured = mockSend();
    const a = createGmailAdapter(baseConfig);
    await a.send(outbound());
    expect(decode(captured.body!.raw as string)).not.toContain('List-Unsubscribe');
  });

  it('strips CRLF so an unsubscribe URL cannot inject headers', async () => {
    const captured = mockSend();
    const a = createGmailAdapter(baseConfig);
    await a.send(
      outbound({ metadata: { unsubscribeUrl: 'https://acme.com/u\r\nBcc: evil@x.com' } }),
    );

    const decoded = decode(captured.body!.raw as string);
    expect(decoded).not.toContain('Bcc: evil@x.com\r\n');
    expect(decoded).toContain('List-Unsubscribe: <https://acme.com/uBcc: evil@x.com>');
  });
});
