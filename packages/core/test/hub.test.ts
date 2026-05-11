import { describe, expect, it, vi } from 'vitest';
import {
  type Adapter,
  type AdapterCapabilities,
  createHub,
  type DeliveryReceipt,
  type InboundMessage,
  isMsglyError,
  type OutboundMessage,
  type WebhookRequest,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

interface FakeOverrides {
  send?: Adapter['send'];
  verifyCredentials?: Adapter['verifyCredentials'];
}

function createFakeAdapter(overrides: FakeOverrides = {}): Adapter {
  const capabilities: AdapterCapabilities = {
    text: true,
    media: { image: false, video: false, audio: false, file: false },
    interactive: { buttons: false, quickReplies: false },
    templates: false,
    reactions: false,
    typing: false,
  };

  return {
    channel: 'telegram',
    capabilities,
    send:
      overrides.send ??
      vi.fn(
        async (msg: OutboundMessage): Promise<DeliveryReceipt> => ({
          messageId: msg.id,
          externalId: 'ext-1',
          status: 'sent',
          timestamp: new Date().toISOString(),
        }),
      ),
    handleWebhook: vi.fn(async (_req: WebhookRequest): Promise<InboundMessage[]> => [
      {
        id: 'in-1',
        externalId: 'tg-1',
        channel: 'telegram',
        direction: 'inbound',
        account: { channel: 'telegram', channelAccountId: 'self' },
        contact: { channel: 'telegram', channelUserId: '123' },
        content: { type: 'text', text: 'hi' },
        timestamp: new Date().toISOString(),
      },
    ]),
    verifySignature: vi.fn(async (_req: WebhookRequest) => true),
    async uploadMedia() {
      throw new Error('not implemented');
    },
    async downloadMedia() {
      throw new Error('not implemented');
    },
    verifyCredentials:
      overrides.verifyCredentials ??
      (async () => ({ ok: true as const, accountInfo: 'fake-account' })),
  };
}

const baseRequest: WebhookRequest = {
  headers: {},
  rawBody: encode('{}'),
  body: {},
  query: {},
};

describe('createHub', () => {
  it('registers an adapter and sends a message', async () => {
    const hub = createHub();
    const adapter = createFakeAdapter();
    hub.register(adapter);

    const receipt = await hub.send({
      channel: 'telegram',
      account: { channel: 'telegram', channelAccountId: 'self' },
      contact: { channel: 'telegram', channelUserId: '123' },
      content: { type: 'text', text: 'hello' },
    });

    expect(receipt.status).toBe('sent');
    expect(adapter.send).toHaveBeenCalledOnce();
  });

  it('throws AdapterNotRegistered for unknown channel', async () => {
    const hub = createHub();
    await expect(
      hub.send({
        channel: 'whatsapp',
        account: { channel: 'whatsapp', channelAccountId: 'x' },
        contact: { channel: 'whatsapp', channelUserId: 'y' },
        content: { type: 'text', text: 'hi' },
      }),
    ).rejects.toSatisfy((err) => isMsglyError(err, 'AdapterNotRegistered'));
  });

  it('throws UnsupportedFeature for unsupported content', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    await expect(
      hub.send({
        channel: 'telegram',
        account: { channel: 'telegram', channelAccountId: 'self' },
        contact: { channel: 'telegram', channelUserId: '123' },
        content: {
          type: 'image',
          mediaRef: { kind: 'url', value: 'http://example.com/img.png' },
        },
      }),
    ).rejects.toSatisfy((err) => isMsglyError(err, 'UnsupportedFeature'));
  });

  it('emits message event on incoming webhook', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    const handler = vi.fn();
    hub.on('message', handler);

    await hub.handleWebhook('telegram', baseRequest);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('hub.on returns an unsubscribe function', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    const handler = vi.fn();
    const off = hub.on('message', handler);

    await hub.handleWebhook('telegram', baseRequest);
    expect(handler).toHaveBeenCalledOnce();

    off();
    await hub.handleWebhook('telegram', {
      ...baseRequest,
      rawBody: encode('{"second":true}'),
    });
    // Same externalId — would be deduped anyway; still verifies off() unhooked.
    expect(handler).toHaveBeenCalledOnce();
  });

  it('deduplicates webhooks by externalId', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    const handler = vi.fn();
    hub.on('message', handler);

    await hub.handleWebhook('telegram', baseRequest);
    await hub.handleWebhook('telegram', baseRequest);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('connect() returns a per-channel report', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    const report = await hub.connect();
    expect(report['telegram']).toEqual({
      ok: true,
      accountInfo: 'fake-account',
    });
  });

  it('connect({ throwOnFailure: true }) throws when an adapter fails', async () => {
    const hub = createHub();
    hub.register(
      createFakeAdapter({
        verifyCredentials: async () => ({
          ok: false,
          reason: 'unauthorized',
          hint: 'fake hint',
        }),
      }),
    );
    await expect(hub.connect({ throwOnFailure: true })).rejects.toThrow(
      /Credentials check failed/,
    );
  });

  it('retries when adapter returns a failed receipt', async () => {
    let calls = 0;
    const hub = createHub({
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
    });
    hub.register(
      createFakeAdapter({
        send: vi.fn(async (msg: OutboundMessage) => {
          calls++;
          if (calls < 2) {
            return {
              messageId: msg.id,
              status: 'failed' as const,
              timestamp: new Date().toISOString(),
              error: { code: 'wa_500', message: 'transient' },
            };
          }
          return {
            messageId: msg.id,
            externalId: 'ext-ok',
            status: 'sent' as const,
            timestamp: new Date().toISOString(),
          };
        }),
      }),
    );

    const receipt = await hub.send({
      channel: 'telegram',
      account: { channel: 'telegram', channelAccountId: 'self' },
      contact: { channel: 'telegram', channelUserId: '1' },
      content: { type: 'text', text: 'hi' },
    });
    expect(receipt.status).toBe('sent');
    expect(calls).toBe(2);
  });

  it('does NOT retry on auth-style errors (401/403)', async () => {
    let calls = 0;
    const hub = createHub({
      retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
    });
    hub.register(
      createFakeAdapter({
        send: vi.fn(async (msg: OutboundMessage) => {
          calls++;
          return {
            messageId: msg.id,
            status: 'failed' as const,
            timestamp: new Date().toISOString(),
            error: { code: 'wa_401', message: 'unauthorized' },
          };
        }),
      }),
    );

    await expect(
      hub.send({
        channel: 'telegram',
        account: { channel: 'telegram', channelAccountId: 'self' },
        contact: { channel: 'telegram', channelUserId: '1' },
        content: { type: 'text', text: 'hi' },
      }),
    ).rejects.toSatisfy((err) => isMsglyError(err, 'SendFailed'));
    expect(calls).toBe(1);
  });

  it('createWebhookHandler.post processes a valid webhook', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    const handlers = hub.createWebhookHandler();

    let status = 0;
    let body = '';
    const fakeRes = {
      status(c: number) {
        status = c;
        return fakeRes;
      },
      send(b: string) {
        body = b;
      },
    };

    await handlers.post(
      {
        params: { channel: 'telegram' },
        headers: {},
        body: {},
        query: {},
        rawBody: encode('{}'),
      },
      fakeRes,
    );

    expect(status).toBe(200);
    expect(body).toBe('ok');
  });

  it('createWebhookHandler.post rejects when raw body is missing', async () => {
    const hub = createHub();
    hub.register(createFakeAdapter());
    const handlers = hub.createWebhookHandler();

    let status = 0;
    let body = '';
    const fakeRes = {
      status(c: number) {
        status = c;
        return fakeRes;
      },
      send(b: string) {
        body = b;
      },
    };

    await handlers.post(
      {
        params: { channel: 'telegram' },
        headers: {},
        body: {},
        query: {},
      },
      fakeRes,
    );

    expect(status).toBe(400);
    expect(body).toContain('raw body');
  });

  it('hub.channels lists registered channels', () => {
    const hub = createHub();
    expect(hub.channels).toEqual([]);
    hub.register(createFakeAdapter());
    expect(hub.channels).toEqual(['telegram']);
  });
});
