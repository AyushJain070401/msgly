import { describe, expect, it, vi } from 'vitest';
import {
  Adapter,
  AdapterNotRegisteredError,
  type AdapterCapabilities,
  type ChannelName,
  type DeliveryReceipt,
  type InboundMessage,
  MessagingHub,
  type OutboundMessage,
  UnsupportedFeatureError,
  type WebhookRequest,
} from '../src/index.js';

class FakeAdapter extends Adapter<{ secret: string }> {
  readonly channel: ChannelName = 'telegram';
  readonly capabilities: AdapterCapabilities = {
    text: true,
    media: { image: false, video: false, audio: false, file: false },
    interactive: { buttons: false, quickReplies: false },
    templates: false,
    reactions: false,
    typing: false,
  };

  send = vi.fn(
    async (msg: OutboundMessage): Promise<DeliveryReceipt> => ({
      messageId: msg.id,
      externalId: 'ext-1',
      status: 'sent',
      timestamp: new Date().toISOString(),
    }),
  );

  handleWebhook = vi.fn(async (_req: WebhookRequest): Promise<InboundMessage[]> => [
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
  ]);

  verifySignature = vi.fn((_req: WebhookRequest) => true);

  async uploadMedia() {
    throw new Error('not implemented');
  }
  async downloadMedia() {
    throw new Error('not implemented');
  }
  async verifyCredentials() {
    return { ok: true as const, accountInfo: 'fake-account' };
  }
}

const baseRequest: WebhookRequest = {
  headers: {},
  rawBody: Buffer.from('{}'),
  body: {},
  query: {},
};

describe('MessagingHub', () => {
  it('registers an adapter and sends a message', async () => {
    const hub = new MessagingHub();
    const adapter = new FakeAdapter({ secret: 'x' });
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

  it('throws AdapterNotRegisteredError for unknown channel', async () => {
    const hub = new MessagingHub();
    await expect(
      hub.send({
        channel: 'whatsapp',
        account: { channel: 'whatsapp', channelAccountId: 'x' },
        contact: { channel: 'whatsapp', channelUserId: 'y' },
        content: { type: 'text', text: 'hi' },
      }),
    ).rejects.toBeInstanceOf(AdapterNotRegisteredError);
  });

  it('throws UnsupportedFeatureError for unsupported content', async () => {
    const hub = new MessagingHub();
    hub.register(new FakeAdapter({ secret: 'x' }));
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
    ).rejects.toBeInstanceOf(UnsupportedFeatureError);
  });

  it('emits message event on incoming webhook', async () => {
    const hub = new MessagingHub();
    hub.register(new FakeAdapter({ secret: 'x' }));
    const handler = vi.fn();
    hub.on('message', handler);

    await hub.handleWebhook('telegram', baseRequest);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('deduplicates webhooks by externalId', async () => {
    const hub = new MessagingHub();
    hub.register(new FakeAdapter({ secret: 'x' }));
    const handler = vi.fn();
    hub.on('message', handler);

    await hub.handleWebhook('telegram', baseRequest);
    await hub.handleWebhook('telegram', baseRequest);
    expect(handler).toHaveBeenCalledOnce();
  });

  it('connect() returns a per-channel report', async () => {
    const hub = new MessagingHub();
    hub.register(new FakeAdapter({ secret: 'x' }));
    const report = await hub.connect();
    expect(report['telegram']).toEqual({
      ok: true,
      accountInfo: 'fake-account',
    });
  });

  it('connect({ throwOnFailure: true }) throws when an adapter fails', async () => {
    class BadAdapter extends FakeAdapter {
      override async verifyCredentials() {
        return {
          ok: false as const,
          reason: 'unauthorized' as const,
          hint: 'fake hint',
        };
      }
    }
    const hub = new MessagingHub();
    hub.register(new BadAdapter({ secret: 'x' }));
    await expect(hub.connect({ throwOnFailure: true })).rejects.toThrow(
      /Credentials check failed/,
    );
  });

  it('retries when adapter returns a failed receipt', async () => {
    let calls = 0;
    class FlakyAdapter extends FakeAdapter {
      override send = vi.fn(async (msg: OutboundMessage) => {
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
      });
    }
    const hub = new MessagingHub({
      retry: { maxAttempts: 3, initialDelayMs: 1, maxDelayMs: 2 },
    });
    hub.register(new FlakyAdapter({ secret: 'x' }));
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
    class AuthErrorAdapter extends FakeAdapter {
      override send = vi.fn(async (msg: OutboundMessage) => {
        calls++;
        return {
          messageId: msg.id,
          status: 'failed' as const,
          timestamp: new Date().toISOString(),
          error: { code: 'wa_401', message: 'unauthorized' },
        };
      });
    }
    const hub = new MessagingHub({
      retry: { maxAttempts: 5, initialDelayMs: 1, maxDelayMs: 2 },
    });
    hub.register(new AuthErrorAdapter({ secret: 'x' }));
    await expect(
      hub.send({
        channel: 'telegram',
        account: { channel: 'telegram', channelAccountId: 'self' },
        contact: { channel: 'telegram', channelUserId: '1' },
        content: { type: 'text', text: 'hi' },
      }),
    ).rejects.toBeDefined();
    expect(calls).toBe(1); // only one attempt
  });

  it('createWebhookHandler.post processes a valid webhook', async () => {
    const hub = new MessagingHub();
    hub.register(new FakeAdapter({ secret: 'x' }));
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
        rawBody: Buffer.from('{}'),
      },
      fakeRes,
    );

    expect(status).toBe(200);
    expect(body).toBe('ok');
  });

  it('createWebhookHandler.post rejects when raw body is missing', async () => {
    const hub = new MessagingHub();
    hub.register(new FakeAdapter({ secret: 'x' }));
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
    const hub = new MessagingHub();
    expect(hub.channels).toEqual([]);
    hub.register(new FakeAdapter({ secret: 'x' }));
    expect(hub.channels).toEqual(['telegram']);
  });
});
