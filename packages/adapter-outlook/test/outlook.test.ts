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
