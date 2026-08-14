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

describe('hub.sendBulk', () => {
  const account = { channel: 'telegram' as const, channelAccountId: 'self' };

  function recipients(n: number) {
    return Array.from({ length: n }, (_, i) => ({
      contact: { channel: 'telegram' as const, channelUserId: `user-${i}` },
    }));
  }

  function bulkHub(overrides: FakeOverrides = {}) {
    const hub = createHub({ retry: { maxAttempts: 1, initialDelayMs: 1, maxDelayMs: 2 } });
    const adapter = createFakeAdapter(overrides);
    hub.register(adapter);
    return { hub, adapter };
  }

  it('sends to every recipient and reports them all', async () => {
    const { hub, adapter } = bulkHub();

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(5),
      content: { type: 'text', text: 'hello everyone' },
      rateLimit: false,
    });

    expect(result.total).toBe(5);
    expect(result.sent).toBe(5);
    expect(result.failed).toBe(0);
    expect(result.results).toHaveLength(5);
    expect(adapter.send).toHaveBeenCalledTimes(5);
  });

  it('keeps going when one recipient fails, and resolves rather than throwing', async () => {
    const send = vi.fn(async (msg: OutboundMessage): Promise<DeliveryReceipt> => {
      if (msg.contact.channelUserId === 'user-2') {
        return {
          messageId: msg.id,
          status: 'failed',
          timestamp: new Date().toISOString(),
          error: { code: 'tg_400', message: 'chat not found' },
        };
      }
      return {
        messageId: msg.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    });
    const { hub } = bulkHub({ send });

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(5),
      content: { type: 'text', text: 'hi' },
      rateLimit: false,
    });

    expect(result.sent).toBe(4);
    expect(result.failed).toBe(1);
    expect(result.results[2]!.status).toBe('failed');
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]!.contact.channelUserId).toBe('user-2');
    expect(isMsglyError(result.failures[0]!.error, 'SendFailed')).toBe(true);
  });

  it('returns results in input order even when sends settle out of order', async () => {
    const send = vi.fn(async (msg: OutboundMessage): Promise<DeliveryReceipt> => {
      // First recipient is slowest, so completion order != input order.
      const delay = msg.contact.channelUserId === 'user-0' ? 30 : 1;
      await new Promise((r) => setTimeout(r, delay));
      return { messageId: msg.id, status: 'sent', timestamp: new Date().toISOString() };
    });
    const { hub } = bulkHub({ send });

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(4),
      content: { type: 'text', text: 'hi' },
      concurrency: 4,
      rateLimit: false,
    });

    expect(result.results.map((r) => r.contact.channelUserId)).toEqual([
      'user-0',
      'user-1',
      'user-2',
      'user-3',
    ]);
  });

  it('resolves content per recipient so campaigns can personalize', async () => {
    const { hub, adapter } = bulkHub();
    const resolver = vi.fn((recipient: { contact: { channelUserId: string } }) => ({
      type: 'text' as const,
      text: `hi ${recipient.contact.channelUserId}`,
    }));

    await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(3),
      content: resolver,
      rateLimit: false,
    });

    expect(resolver).toHaveBeenCalledTimes(3);
    const texts = (adapter.send as ReturnType<typeof vi.fn>).mock.calls.map(
      (c) => (c[0] as OutboundMessage).content,
    );
    expect(texts).toContainEqual({ type: 'text', text: 'hi user-1' });
  });

  it('fails only the affected recipient when the content resolver throws', async () => {
    const { hub } = bulkHub();

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(3),
      content: (r) => {
        if (r.contact.channelUserId === 'user-1') throw new Error('no merge data');
        return { type: 'text', text: 'ok' };
      },
      rateLimit: false,
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(result.failures[0]!.error.message).toContain('no merge data');
  });

  it('fails one recipient when the resolver returns unsupported content', async () => {
    const { hub } = bulkHub();

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(3),
      content: (r) =>
        r.contact.channelUserId === 'user-0'
          ? { type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } }
          : { type: 'text', text: 'ok' },
      rateLimit: false,
    });

    expect(result.sent).toBe(2);
    expect(result.failed).toBe(1);
    expect(isMsglyError(result.failures[0]!.error, 'UnsupportedFeature')).toBe(true);
  });

  it('throws up front for an unregistered channel without sending anything', async () => {
    const { hub, adapter } = bulkHub();
    await expect(
      hub.sendBulk({
        channel: 'whatsapp',
        account: { channel: 'whatsapp', channelAccountId: 'x' },
        recipients: recipients(3),
        content: { type: 'text', text: 'hi' },
        rateLimit: false,
      }),
    ).rejects.toSatisfy((err) => isMsglyError(err, 'AdapterNotRegistered'));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('throws up front for statically unsupported content', async () => {
    const { hub, adapter } = bulkHub();
    await expect(
      hub.sendBulk({
        channel: 'telegram',
        account,
        recipients: recipients(3),
        content: { type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } },
        rateLimit: false,
      }),
    ).rejects.toSatisfy((err) => isMsglyError(err, 'UnsupportedFeature'));
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('reuses the existing delivery and error events, adding none of its own', async () => {
    const send = vi.fn(async (msg: OutboundMessage): Promise<DeliveryReceipt> =>
      msg.contact.channelUserId === 'user-1'
        ? {
            messageId: msg.id,
            status: 'failed',
            timestamp: new Date().toISOString(),
            error: { code: 'tg_400', message: 'nope' },
          }
        : { messageId: msg.id, status: 'sent', timestamp: new Date().toISOString() },
    );
    const { hub } = bulkHub({ send });

    const deliveries: DeliveryReceipt[] = [];
    const errors: Error[] = [];
    hub.on('delivery', (r) => deliveries.push(r));
    hub.on('error', (e) => errors.push(e));

    await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(3),
      content: { type: 'text', text: 'hi' },
      rateLimit: false,
    });

    // One delivery per recipient (failures emit a delivery too, as send() does).
    expect(deliveries).toHaveLength(3);
    expect(errors).toHaveLength(1);
  });

  it('never exceeds the requested concurrency', async () => {
    let inFlight = 0;
    let peak = 0;
    const send = vi.fn(async (msg: OutboundMessage): Promise<DeliveryReceipt> => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight--;
      return { messageId: msg.id, status: 'sent', timestamp: new Date().toISOString() };
    });
    const { hub } = bulkHub({ send });

    await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(12),
      content: { type: 'text', text: 'hi' },
      concurrency: 3,
      rateLimit: false,
    });

    expect(peak).toBeLessThanOrEqual(3);
  });

  it('reports progress once per recipient and survives a throwing callback', async () => {
    const { hub } = bulkHub();
    const seen: number[] = [];

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(4),
      content: { type: 'text', text: 'hi' },
      rateLimit: false,
      onProgress: (p) => {
        seen.push(p.completed);
        throw new Error('progress handler blew up');
      },
    });

    expect(seen).toEqual([1, 2, 3, 4]);
    expect(result.sent).toBe(4);
  });

  it('stops early on abort, resolving with partial results', async () => {
    const controller = new AbortController();
    let calls = 0;
    const send = vi.fn(async (msg: OutboundMessage): Promise<DeliveryReceipt> => {
      calls++;
      if (calls === 2) controller.abort();
      return { messageId: msg.id, status: 'sent', timestamp: new Date().toISOString() };
    });
    const { hub } = bulkHub({ send });

    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(10),
      content: { type: 'text', text: 'hi' },
      concurrency: 1,
      rateLimit: false,
      signal: controller.signal,
    });

    expect(result.cancelled).toBe(true);
    expect(result.results).toHaveLength(10);
    expect(calls).toBeLessThan(10);
    // Anything actually handed to the adapter is reported truthfully, never
    // relabelled as cancelled.
    expect(result.sent).toBe(calls);
    expect(result.results.at(-1)!.status).toBe('cancelled');
  });

  it('sends nothing when the signal is already aborted', async () => {
    const { hub, adapter } = bulkHub();
    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: recipients(4),
      content: { type: 'text', text: 'hi' },
      rateLimit: false,
      signal: AbortSignal.abort(),
    });

    expect(adapter.send).not.toHaveBeenCalled();
    expect(result.cancelled).toBe(true);
    expect(result.results.every((r) => r.status === 'cancelled')).toBe(true);
  });

  it('handles an empty recipient list without touching the adapter', async () => {
    const { hub, adapter } = bulkHub();
    const result = await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: [],
      content: { type: 'text', text: 'hi' },
    });

    expect(result).toMatchObject({ total: 0, sent: 0, failed: 0, cancelled: false });
    expect(adapter.send).not.toHaveBeenCalled();
  });

  it('merges campaign metadata with per-recipient metadata', async () => {
    const { hub, adapter } = bulkHub();

    await hub.sendBulk({
      channel: 'telegram',
      account,
      recipients: [
        {
          contact: { channel: 'telegram', channelUserId: 'u1' },
          metadata: { crmId: 'c-1' },
        },
      ],
      content: { type: 'text', text: 'hi' },
      metadata: { campaign: 'spring-sale' },
      rateLimit: false,
    });

    const sentMessage = (adapter.send as ReturnType<typeof vi.fn>).mock
      .calls[0]![0] as OutboundMessage;
    expect(sentMessage.metadata).toEqual({ campaign: 'spring-sale', crmId: 'c-1' });
  });
});
