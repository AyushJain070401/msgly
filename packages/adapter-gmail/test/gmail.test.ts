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
