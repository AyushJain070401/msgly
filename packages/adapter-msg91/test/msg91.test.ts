import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMsg91Adapter, normalizeMobile } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const baseConfig = {
  authKey: 'auth-123',
  senderId: 'ACMECO',
  apiBase: 'https://control.test.local',
};

const contact = { channel: 'msg91' as const, channelUserId: '+91 99999 99999' };
const account = { channel: 'msg91' as const, channelAccountId: 'ACMECO' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockFlow(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return {
      ok: status < 400,
      status,
      json: async () => payload,
      text: async () => JSON.stringify(payload),
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function req(overrides: Record<string, unknown> = {}) {
  return {
    headers: {},
    rawBody: encode(''),
    body: {},
    query: {},
    ...overrides,
  } as Parameters<ReturnType<typeof createMsg91Adapter>['handleWebhook']>[0];
}

function outbound(content: Parameters<ReturnType<typeof createMsg91Adapter>['send']>[0]['content'], metadata?: Record<string, unknown>) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'msg91' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...(metadata ? { metadata } : {}),
  };
}

describe('createMsg91Adapter', () => {
  it('declares the msg91 channel and template support', () => {
    const a = createMsg91Adapter(baseConfig);
    expect(a.channel).toBe('msg91');
    expect(a.capabilities.text).toBe(true);
    // The meaningful difference from the other SMS adapters.
    expect(a.capabilities.templates).toBe(true);
    expect(a.capabilities.media.image).toBe(false);
  });

  it('sends template content through the Flow API', async () => {
    const calls = mockFlow({ message: 'req-abc-123', type: 'success' });

    const a = createMsg91Adapter(baseConfig);
    const receipt = await a.send(
      outbound({
        type: 'template',
        templateName: 'tpl_order_update',
        language: 'en',
        variables: { NAME: 'Ayush', ORDER: 'ORD-1' },
      }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('req-abc-123');
    expect(calls[0]!.url).toBe('https://control.test.local/api/v5/flow/');

    const headers = calls[0]!.init!.headers as Record<string, string>;
    expect(headers.authkey).toBe('auth-123');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.template_id).toBe('tpl_order_update');
    expect(body.sender).toBe('ACMECO');
    expect(body.recipients).toEqual([
      { mobiles: '919999999999', NAME: 'Ayush', ORDER: 'ORD-1' },
    ]);
  });

  it('sends text through the default template variable', async () => {
    const calls = mockFlow({ message: 'req-1', type: 'success' });

    const a = createMsg91Adapter({ ...baseConfig, defaultTemplateId: 'tpl_default' });
    await a.send(outbound({ type: 'text', text: 'Your OTP is 4321' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.template_id).toBe('tpl_default');
    expect(body.recipients[0].MESSAGE).toBe('Your OTP is 4321');
  });

  it('honours a custom text variable name', async () => {
    const calls = mockFlow({ message: 'req-1', type: 'success' });

    const a = createMsg91Adapter({
      ...baseConfig,
      defaultTemplateId: 'tpl_default',
      defaultTextVariable: 'BODY',
    });
    await a.send(outbound({ type: 'text', text: 'hi' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.recipients[0].BODY).toBe('hi');
    expect(body.recipients[0].MESSAGE).toBeUndefined();
  });

  it('lets metadata pick the template per message', async () => {
    const calls = mockFlow({ message: 'req-1', type: 'success' });

    const a = createMsg91Adapter({ ...baseConfig, defaultTemplateId: 'tpl_default' });
    await a.send(outbound({ type: 'text', text: 'hi' }, { templateId: 'tpl_campaign' }));

    expect(JSON.parse(calls[0]!.init!.body as string).template_id).toBe('tpl_campaign');
  });

  it('explains that a template is mandatory when none is configured', async () => {
    const calls = mockFlow({ message: 'x', type: 'success' });

    const a = createMsg91Adapter(baseConfig); // no defaultTemplateId
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('msg91_missing_template');
    expect(receipt.error?.message).toContain('DLT-approved template');
    // Must fail before spending an API call.
    expect(calls).toHaveLength(0);
  });

  it('treats type:error as a failure even on HTTP 200', async () => {
    mockFlow({ message: 'Invalid template_id', type: 'error' }, 200);

    const a = createMsg91Adapter({ ...baseConfig, defaultTemplateId: 'tpl' });
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.message).toBe('Invalid template_id');
  });

  it('reports a network failure without throwing', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => {
      throw new Error('ECONNRESET');
    }) as unknown as typeof fetch;

    const a = createMsg91Adapter({ ...baseConfig, defaultTemplateId: 'tpl' });
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('msg91_network_error');
  });

  it('rejects unsupported content types', async () => {
    const a = createMsg91Adapter({ ...baseConfig, defaultTemplateId: 'tpl' });
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('msg91_unsupported_content');
  });

  it('parses an inbound SMS', async () => {
    const a = createMsg91Adapter(baseConfig);
    const messages = await a.handleWebhook(
      req({
        body: {
          sender: '919888888888',
          content: 'STOP',
          receiver: 'ACMECO',
          requestId: 'req-in-1',
          date: '2026-01-01 10:00:00',
        },
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('msg91');
    expect(m.direction).toBe('inbound');
    expect((m.content as { text: string }).text).toBe('STOP');
    expect(m.contact.channelUserId).toBe('919888888888');
    expect(m.externalId).toBe('req-in-1');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('accepts the alternative field spellings MSG91 uses', async () => {
    const a = createMsg91Adapter(baseConfig);
    const messages = await a.handleWebhook(
      req({ body: { from: '919777777777', message: 'hello', to: 'ACMECO' } }),
    );

    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('hello');
    expect(messages[0]!.contact.channelUserId).toBe('919777777777');
  });

  it('ignores delivery reports, which carry no body', async () => {
    const a = createMsg91Adapter(baseConfig);
    const messages = await a.handleWebhook(
      req({ body: { sender: '919888888888', status: 'delivered', requestId: 'r-1' } }),
    );
    expect(messages).toEqual([]);
  });

  it('accepts any webhook when no token is configured', async () => {
    const a = createMsg91Adapter(baseConfig);
    expect(await a.verifySignature(req())).toBe(true);
  });

  it('requires a matching token when one is configured', async () => {
    // MSG91 does not sign webhooks, so the shared secret is the only guard.
    const a = createMsg91Adapter({ ...baseConfig, webhookToken: 's3cret' });
    expect(await a.verifySignature(req({ query: { token: 's3cret' } }))).toBe(true);
    expect(await a.verifySignature(req({ query: { token: 'nope' } }))).toBe(false);
    expect(await a.verifySignature(req({ query: {} }))).toBe(false);
  });

  it('verifyCredentials reports the balance on success', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({ ok: true, status: 200, text: async () => '250.75' }) as unknown as Response,
    ) as unknown as typeof fetch;

    const result = await createMsg91Adapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.accountInfo).toContain('ACMECO');
      expect(result.accountInfo).toContain('250.75');
    }
  });

  it('verifyCredentials detects a rejected auth key in a 200 body', async () => {
    // MSG91 answers a bad key with HTTP 200 and an error string.
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          text: async () => 'Invalid authkey',
        }) as unknown as Response,
    ) as unknown as typeof fetch;

    const result = await createMsg91Adapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('verifyCredentials returns a hint when the auth key is missing', async () => {
    const result = await createMsg91Adapter({
      ...baseConfig,
      authKey: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('authKey');
  });
});

describe('normalizeMobile', () => {
  it('strips everything that is not a digit', () => {
    expect(normalizeMobile('+91 99999 99999')).toBe('919999999999');
    expect(normalizeMobile('+91-99999-99999')).toBe('919999999999');
    expect(normalizeMobile('919999999999')).toBe('919999999999');
  });
});
