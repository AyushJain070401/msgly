import { afterEach, describe, expect, it, vi } from 'vitest';

import { createExotelAdapter, mapExotelStatus } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  accountSid: 'acme1',
  apiKey: 'key-123',
  apiToken: 'token-456',
  senderId: 'ACMECO',
  subdomain: 'api.test.local',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function sendOk(sid = 'sms-1', status = 'queued') {
  return vi.fn().mockImplementation(
    async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ SMSMessage: { Sid: sid, Status: status } }),
      }) as Response,
  ) as unknown as typeof fetch;
}

function req(overrides: Partial<Parameters<ReturnType<typeof createExotelAdapter>['handleWebhook']>[0]> = {}) {
  return {
    headers: {},
    rawBody: encode(''),
    body: {},
    query: {},
    ...overrides,
  };
}

describe('createExotelAdapter', () => {
  it('declares the exotel channel and text-only capabilities', () => {
    const a = createExotelAdapter(baseConfig);
    expect(a.channel).toBe('exotel');
    expect(a.capabilities.text).toBe(true);
    // Exotel SMS has no MMS equivalent.
    expect(a.capabilities.media.image).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(false);
  });

  it('sends an SMS with Basic Auth and the configured sender', async () => {
    let url = '';
    let init: RequestInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (u: string, i?: RequestInit) => {
      url = u;
      init = i;
      return {
        ok: true,
        status: 200,
        json: async () => ({ SMSMessage: { Sid: 'sms-abc', Status: 'queued' } }),
      } as Response;
    }) as unknown as typeof fetch;

    const a = createExotelAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'exotel',
      account: { channel: 'exotel', channelAccountId: 'ACMECO' },
      contact: { channel: 'exotel', channelUserId: '+919999999999' },
      content: { type: 'text', text: 'Your OTP is 123456' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('queued');
    expect(receipt.externalId).toBe('sms-abc');
    expect(url).toBe('https://api.test.local/v1/Accounts/acme1/Sms/send.json');

    const headers = init!.headers as Record<string, string>;
    expect(headers.authorization).toBe(`Basic ${btoa('key-123:token-456')}`);

    const form = new URLSearchParams(init!.body as string);
    expect(form.get('From')).toBe('ACMECO');
    expect(form.get('To')).toBe('+919999999999');
    expect(form.get('Body')).toBe('Your OTP is 123456');
    expect(form.get('SmsType')).toBe('transactional');
  });

  it('includes DLT ids from config', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_u: string, i?: RequestInit) => {
      init = i;
      return {
        ok: true,
        status: 200,
        json: async () => ({ SMSMessage: { Sid: 's', Status: 'sent' } }),
      } as Response;
    }) as unknown as typeof fetch;

    const a = createExotelAdapter({
      ...baseConfig,
      dltEntityId: 'ENTITY-1',
      dltTemplateId: 'TPL-1',
      smsType: 'promotional' as const,
    });
    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'exotel',
      account: { channel: 'exotel', channelAccountId: 'ACMECO' },
      contact: { channel: 'exotel', channelUserId: '+919999999999' },
      content: { type: 'text', text: 'sale!' },
      timestamp: new Date().toISOString(),
    });

    const form = new URLSearchParams(init!.body as string);
    expect(form.get('DltEntityId')).toBe('ENTITY-1');
    expect(form.get('DltTemplateId')).toBe('TPL-1');
    expect(form.get('SmsType')).toBe('promotional');
  });

  it('lets metadata override the DLT template per message', async () => {
    let init: RequestInit | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (_u: string, i?: RequestInit) => {
      init = i;
      return {
        ok: true,
        status: 200,
        json: async () => ({ SMSMessage: { Sid: 's', Status: 'sent' } }),
      } as Response;
    }) as unknown as typeof fetch;

    const a = createExotelAdapter({ ...baseConfig, dltTemplateId: 'TPL-DEFAULT' });
    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'exotel',
      account: { channel: 'exotel', channelAccountId: 'ACMECO' },
      contact: { channel: 'exotel', channelUserId: '+919999999999' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
      metadata: { dltTemplateId: 'TPL-CAMPAIGN' },
    });

    expect(new URLSearchParams(init!.body as string).get('DltTemplateId')).toBe(
      'TPL-CAMPAIGN',
    );
  });

  it('surfaces a RestException as a failed receipt', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: false,
          status: 400,
          json: async () => ({
            RestException: { Status: 400, Message: 'Invalid DltTemplateId' },
          }),
        }) as Response,
    ) as unknown as typeof fetch;

    const a = createExotelAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'exotel',
      account: { channel: 'exotel', channelAccountId: 'ACMECO' },
      contact: { channel: 'exotel', channelUserId: '+919999999999' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('exotel_400');
    expect(receipt.error?.message).toBe('Invalid DltTemplateId');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNREFUSED');
    }) as unknown as typeof fetch;

    const a = createExotelAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'exotel',
      account: { channel: 'exotel', channelAccountId: 'ACMECO' },
      contact: { channel: 'exotel', channelUserId: '+919999999999' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('exotel_network_error');
  });

  it('rejects non-text content with a clear error', async () => {
    globalThis.fetch = sendOk();
    const a = createExotelAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'exotel',
      account: { channel: 'exotel', channelAccountId: 'ACMECO' },
      contact: { channel: 'exotel', channelUserId: '+919999999999' },
      content: { type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('exotel_unsupported_content');
  });

  it('parses an inbound SMS from POST form fields', async () => {
    const a = createExotelAdapter(baseConfig);
    const messages = await a.handleWebhook(
      req({
        body: {
          SmsSid: 'sms-in-1',
          From: '+919888888888',
          To: '09012345678',
          Body: 'STOP',
          DateReceived: '2026-01-01 10:00:00',
        },
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('exotel');
    expect(m.direction).toBe('inbound');
    expect(m.externalId).toBe('sms-in-1');
    expect((m.content as { text: string }).text).toBe('STOP');
    expect(m.contact.channelUserId).toBe('+919888888888');
    expect(m.account.channelAccountId).toBe('09012345678');
  });

  it('parses an inbound SMS delivered as GET query parameters', async () => {
    const a = createExotelAdapter(baseConfig);
    const messages = await a.handleWebhook(
      req({
        query: { SmsSid: 'sms-in-2', From: '+919777777777', To: '090123', Body: 'hi' },
      }),
    );

    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('hi');
  });

  it('ignores status callbacks, which carry no message body', async () => {
    const a = createExotelAdapter(baseConfig);
    const messages = await a.handleWebhook(
      req({
        body: { SmsSid: 'sms-1', From: 'ACMECO', To: '+9199', Status: 'delivered' },
      }),
    );
    expect(messages).toEqual([]);
  });

  it('accepts any webhook when no token is configured', async () => {
    const a = createExotelAdapter(baseConfig);
    expect(await a.verifySignature(req())).toBe(true);
  });

  it('requires a matching token when one is configured', async () => {
    // Exotel does not sign webhooks, so a shared secret in the URL is the
    // only thing standing between the endpoint and forged inbound SMS.
    const a = createExotelAdapter({ ...baseConfig, webhookToken: 's3cret' });

    expect(await a.verifySignature(req({ query: { token: 's3cret' } }))).toBe(true);
    expect(await a.verifySignature(req({ query: { token: 'wrong' } }))).toBe(false);
    expect(await a.verifySignature(req({ query: {} }))).toBe(false);
  });

  it('verifyCredentials succeeds against a healthy account', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: true, status: 200, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createExotelAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('ACMECO');
  });

  it('verifyCredentials reports a 401 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 401, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createExotelAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('verifyCredentials hints about the wrong regional cluster on 404', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 404, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createExotelAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('not_found');
      expect(result.hint).toContain('api.in.exotel.com');
    }
  });

  it('verifyCredentials returns a hint when the API key is missing', async () => {
    const result = await createExotelAdapter({
      ...baseConfig,
      apiKey: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('apiKey');
  });
});

describe('mapExotelStatus', () => {
  it('maps the Exotel lifecycle onto unified statuses', () => {
    expect(mapExotelStatus('queued')).toBe('queued');
    expect(mapExotelStatus('submitted')).toBe('queued');
    expect(mapExotelStatus('sent')).toBe('sent');
    expect(mapExotelStatus('delivered')).toBe('delivered');
    expect(mapExotelStatus('failed_dnd')).toBe('failed');
    expect(mapExotelStatus('expired')).toBe('failed');
    expect(mapExotelStatus(undefined)).toBe('sent');
  });
});
