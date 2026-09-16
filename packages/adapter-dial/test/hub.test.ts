/**
 * End-to-end checks through the real hub rather than the adapter alone.
 *
 * The adapter's own suite proves it returns the right shapes; this proves the
 * hub accepts them — capability gating, retry classification, webhook routing
 * and rate-limited fan-out all behave differently from calling `send` directly.
 */
import { createHub } from '@msgly/core';
import type { Adapter } from '@msgly/core';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createDialAdapter } from '../src/index.js';

const baseConfig = {
  apiKey: 'sk_live_0123456789',
  fromNumber: '+15550001111',
  apiBase: 'https://api.test.local',
};

const contact = { channel: 'dial' as const, channelUserId: '+15550002222' };
const account = { channel: 'dial' as const, channelAccountId: '+15550001111' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockApi(payload: unknown, status = 200) {
  const fn = vi.fn().mockImplementation(async () => ({
    ok: status < 400,
    status,
    json: async () => payload,
  }));
  globalThis.fetch = fn as unknown as typeof fetch;
  return fn;
}

/** Structural conformance — fails to compile if the contract drifts. */
it('satisfies the Adapter contract', () => {
  const adapter: Adapter = createDialAdapter(baseConfig);
  expect(adapter.channel).toBe('dial');
});

describe('through createHub', () => {
  function hub() {
    const h = createHub();
    h.register(createDialAdapter({ ...baseConfig, webhookSecret: undefined }));
    return h;
  }

  it('registers as a channel with no core changes', () => {
    expect(hub().channels).toContain('dial');
  });

  it('sends end-to-end and emits a delivery event', async () => {
    mockApi({ message: { id: 'msg_1', deliveryState: 'delivered' } }, 201);
    const h = hub();
    const seen: unknown[] = [];
    h.on('delivery', (r) => void seen.push(r));

    const receipt = await h.send({
      channel: 'dial',
      account,
      contact,
      content: { type: 'text', text: 'hello' },
    });

    expect(receipt.status).toBe('delivered');
    expect(receipt.externalId).toBe('msg_1');
    expect(seen).toHaveLength(1);
  });

  it('accepts every media kind the adapter advertises', async () => {
    mockApi({ message: { id: 'msg_2' } }, 201);
    const h = hub();

    for (const type of ['image', 'video', 'audio', 'file'] as const) {
      const receipt = await h.send({
        channel: 'dial',
        account,
        contact,
        content: { type, mediaRef: { kind: 'url', value: 'https://cdn.test/f' } },
      });
      expect(receipt.status).toBe('sent');
    }
  });

  it('rejects content the channel cannot send, before any HTTP call', async () => {
    const fetchSpy = mockApi({}, 200);
    const h = hub();

    await expect(
      h.send({
        channel: 'dial',
        account,
        contact,
        content: { type: 'location', latitude: 1, longitude: 2 },
      }),
    ).rejects.toThrow();

    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('does NOT retry a 4xx — retryable:false is honoured', async () => {
    const fetchSpy = mockApi({ error: { code: 'invalid_to', message: 'bad number' } }, 422);
    const h = hub();

    await expect(
      h.send({ channel: 'dial', account, contact, content: { type: 'text', text: 'x' } }),
    ).rejects.toThrow();

    // The hub's fallback sniffs the code for an HTTP status and `dial_invalid_to`
    // carries none — so without explicit classification this would retry 3x.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('DOES retry a 5xx', async () => {
    const fetchSpy = mockApi({ error: { code: 'upstream', message: 'boom' } }, 503);
    const h = hub();

    await expect(
      h.send({ channel: 'dial', account, contact, content: { type: 'text', text: 'x' } }),
    ).rejects.toThrow();

    expect(fetchSpy.mock.calls.length).toBeGreaterThan(1);
  });

  it('routes an inbound webhook through the hub', async () => {
    const h = hub();
    const payload = {
      id: 'evt_1',
      type: 'message.received',
      createdAt: '2026-09-16T08:00:00.000Z',
      data: {
        messageId: 'msg_in_1',
        from: '+15550002222',
        to: '+15550001111',
        channel: 'sms',
        body: 'inbound!',
        media: [],
        source: 'external',
      },
    };

    const messages = await h.handleWebhook('dial', {
      headers: {},
      rawBody: new TextEncoder().encode(JSON.stringify(payload)),
      body: payload,
      query: {},
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      channel: 'dial',
      direction: 'inbound',
      content: { type: 'text', text: 'inbound!' },
    });
  });

  it('paces sendBulk to the adapter rate limit rather than the core default', async () => {
    mockApi({ message: { id: 'msg_b' } }, 201);
    const h = hub();

    const started = Date.now();
    const result = await h.sendBulk({
      channel: 'dial',
      account,
      recipients: [
        { contact },
        { contact: { ...contact, channelUserId: '+15550003333' } },
      ],
      content: { type: 'text', text: 'hi' },
    });

    expect(result.sent).toBe(2);
    // 1/s with burst 2 — two recipients fit the burst, so this must not stall.
    expect(Date.now() - started).toBeLessThan(3000);
  });
});
