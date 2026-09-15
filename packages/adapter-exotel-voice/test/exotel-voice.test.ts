import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyExotelCallStatus,
  createExotelVoiceAdapter,
  mapExotelCallStatus,
} from '../src/index.js';

const config = {
  accountSid: 'acme1',
  apiKey: 'key',
  apiToken: 'token',
  callerId: '+918047123456',
  apiBase: 'https://exotel.test.local',
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

const formOf = (calls: Call[], i = 0) =>
  Object.fromEntries(new URLSearchParams(calls[i]!.init!.body as string));

const req = (body: Record<string, string>, query: Record<string, string> = {}) => ({
  headers: {},
  rawBody: new Uint8Array(),
  body,
  query,
});

describe('capabilities', () => {
  it('declares no text or media, because Exotel plays dashboard flows', () => {
    // Claiming text would mean send() accepting content it cannot speak, which
    // is the capability lie this library tries hard to avoid.
    const caps = createExotelVoiceAdapter(config).capabilities;
    expect(caps.text).toBe(false);
    expect(caps.media.audio).toBe(false);
    expect(caps.interactive.buttons).toBe(false);
  });
});

describe('connectNumbers', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('bridges two numbers through the ExoPhone', async () => {
    const calls = mockFetch({ Call: { Sid: 'call-1', Status: 'in-progress' } });
    const result = await createExotelVoiceAdapter(config).connectNumbers(
      '+919000000001',
      '+919000000002',
      { record: true, timeLimit: 600 },
    );

    expect(result).toEqual({ callSid: 'call-1', status: 'in-progress' });
    expect(calls[0]!.url).toBe('https://exotel.test.local/v1/Accounts/acme1/Calls/connect.json');
    expect(formOf(calls)).toEqual({
      From: '+919000000001',
      To: '+919000000002',
      CallerId: '+918047123456',
      TimeLimit: '600',
      Record: 'true',
    });
  });

  it('surfaces Exotel\'s RestException message', async () => {
    mockFetch({ RestException: { Message: 'Invalid CallerId', Status: '400' } }, 400);
    await expect(
      createExotelVoiceAdapter(config).connectNumbers('+91900', '+91901'),
    ).rejects.toThrow(/Invalid CallerId/);
  });
});

describe('connectToFlow', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('dials a number into an App Bazaar flow', async () => {
    const calls = mockFetch({ Call: { Sid: 'call-2', Status: 'queued' } });
    await createExotelVoiceAdapter({ ...config, defaultFlowId: '12345' }).connectToFlow(
      '+919000000002',
    );

    const form = formOf(calls);
    expect(form.From).toBe('+919000000002');
    expect(form.Url).toContain('/acme1/exoml/start_voice/12345');
  });

  it('says where the flow comes from when none is configured', async () => {
    await expect(createExotelVoiceAdapter(config).connectToFlow('+91900')).rejects.toThrow(
      /App Bazaar/,
    );
  });
});

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const outbound = (metadata?: unknown) =>
    ({
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'exotel-voice' as const,
      account: { channel: 'exotel-voice' as const, channelAccountId: '+918047123456' },
      contact: { channel: 'exotel-voice' as const, channelUserId: '+919000000002' },
      content: { type: 'text' as const, text: 'ignored — Exotel plays a flow' },
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    }) as Parameters<ReturnType<typeof createExotelVoiceAdapter>['send']>[0];

  it('triggers a flow, which is the only send this platform has', async () => {
    const calls = mockFetch({ Call: { Sid: 'call-3', Status: 'queued' } });
    const receipt = await createExotelVoiceAdapter(config).send(outbound({ flowId: '999' }));

    expect(receipt.status).toBe('queued');
    expect(receipt.externalId).toBe('call-3');
    expect(receipt.recipientId).toBe('+919000000002');
    expect(formOf(calls).Url).toContain('start_voice/999');
  });

  it('explains what to do when no flow is configured', async () => {
    const receipt = await createExotelVoiceAdapter(config).send(outbound());
    expect(receipt.error?.code).toBe('exotel_voice_flow_required');
    expect(receipt.error?.message).toContain('connectNumbers()');
    expect(receipt.error?.retryable).toBe(false);
  });
});

describe('inbound', () => {
  it('surfaces a Gather keypress, unwrapping the quotes Exotel adds', async () => {
    const messages = await createExotelVoiceAdapter(config).handleWebhook(
      req({
        CallSid: 'call-4',
        CallFrom: '+919000000002',
        CallTo: '+918047123456',
        digits: '"2"',
      }),
    );

    expect(messages).toHaveLength(1);
    expect(messages[0]!.interaction?.data).toBe('2');
    expect(messages[0]!.content).toEqual({ type: 'text', text: '2' });
    expect(messages[0]!.externalId).toBe('call-4');
  });

  it('ignores a terminal status callback, which is a receipt', async () => {
    const messages = await createExotelVoiceAdapter(config).handleWebhook(
      req({ CallSid: 'call-5', CallFrom: '+91900', Status: 'completed' }),
    );
    expect(messages).toEqual([]);
  });

  it('ignores a payload with no call on it', async () => {
    expect(await createExotelVoiceAdapter(config).handleWebhook(req({}))).toEqual([]);
  });
});

describe('parseStatuses', () => {
  it('maps call progress and only suppresses a failed call', () => {
    const adapter = createExotelVoiceAdapter(config);

    expect(adapter.parseStatuses({ CallSid: 'c', Status: 'in-progress' })[0]!.status).toBe('sent');
    expect(adapter.parseStatuses({ CallSid: 'c', Status: 'completed' })[0]!.status).toBe('read');

    const failed = adapter.parseStatuses({
      CallSid: 'c',
      Status: 'failed',
      To: '+919000000002',
      Details: 'number does not exist',
    })[0]!;
    expect(failed.error?.code).toBe('exotel_voice_failed');
    expect(failed.error?.permanent).toBe(true);
    expect(failed.recipientId).toBe('+919000000002');
  });

  it('never suppresses on busy or no-answer', () => {
    const adapter = createExotelVoiceAdapter(config);
    for (const status of ['busy', 'no-answer', 'canceled']) {
      const receipt = adapter.parseStatuses({ CallSid: 'c', Status: status })[0]!;
      expect(receipt.error?.permanent).toBe(false);
      expect(receipt.error?.retryable).toBe(true);
    }
  });

  it('ignores a status it does not recognise', () => {
    expect(createExotelVoiceAdapter(config).parseStatuses({ CallSid: 'c', Status: 'x' })).toEqual([]);
    expect(mapExotelCallStatus(undefined)).toBeNull();
    expect(classifyExotelCallStatus('answered')).toEqual({});
  });
});

describe('verifySignature', () => {
  it('rejects when no token is configured, unless opted out', async () => {
    // Exotel does not sign callbacks, so a URL token is the only guard.
    expect(await createExotelVoiceAdapter(config).verifySignature(req({}))).toBe(false);
    expect(
      await createExotelVoiceAdapter({ ...config, allowUnsignedWebhooks: true }).verifySignature(req({})),
    ).toBe(true);
  });

  it('compares the URL token', async () => {
    const adapter = createExotelVoiceAdapter({ ...config, webhookToken: 'secret123' });
    expect(await adapter.verifySignature(req({}, { token: 'secret123' }))).toBe(true);
    expect(await adapter.verifySignature(req({}, { token: 'secret124' }))).toBe(false);
  });
});

describe('verifyCredentials', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('explains what the Account SID actually is when it is wrong', async () => {
    mockFetch({}, 404);
    const result = await createExotelVoiceAdapter(config).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('subdomain');
  });

  it('accepts working credentials', async () => {
    mockFetch({ Calls: [] });
    expect((await createExotelVoiceAdapter(config).verifyCredentials()).ok).toBe(true);
  });
});
