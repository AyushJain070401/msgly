import { generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  classifyVonageCallStatus,
  contentToNcco,
  createVonageJwt,
  createVonageVoiceAdapter,
  mapVonageCallStatus,
  pemToDer,
} from '../src/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const config = {
  applicationId: '11111111-2222-3333-4444-555555555555',
  privateKey: privateKeyPem,
  phoneNumber: '15551234567',
  apiBase: 'https://vonage.test.local',
};

const req = (body: unknown) => ({
  headers: {},
  rawBody: new Uint8Array(),
  body,
  query: {},
});

describe('application JWT', () => {
  it('signs RS256 with the application id and a unique jti', async () => {
    const decode = (p: string) =>
      JSON.parse(Buffer.from(p.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());

    const a = await createVonageJwt({
      applicationId: config.applicationId,
      privateKeyPem,
      nowSec: 1_700_000_000,
    });
    const b = await createVonageJwt({
      applicationId: config.applicationId,
      privateKeyPem,
      nowSec: 1_700_000_000,
    });

    const [header, payload] = a.split('.');
    expect(decode(header!)).toEqual({ alg: 'RS256', typ: 'JWT' });
    expect(decode(payload!)).toMatchObject({
      application_id: config.applicationId,
      iat: 1_700_000_000,
      exp: 1_700_000_000 + 900,
    });
    // Vonage rejects a replayed token, so two tokens must never match.
    expect(decode(payload!).jti).not.toBe(decode(b.split('.')[1]!).jti);
  });

  it('parses a PEM with escaped newlines, as an env var produces', () => {
    expect(pemToDer(privateKeyPem.replace(/\n/g, '\\n'))).toEqual(pemToDer(privateKeyPem));
  });

  it('reuses a cached token across calls', async () => {
    const calls: string[] = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push((init!.headers as Record<string, string>).authorization!);
      return { status: 200, ok: true, json: async () => ({ uuid: 'c1' }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const adapter = createVonageVoiceAdapter(config);
    await adapter.initiateCall('15559999999', { ncco: [] });
    await adapter.initiateCall('15559999999', { ncco: [] });
    expect(calls[0]).toBe(calls[1]);
  });
});

describe('NCCO mapping', () => {
  it('speaks text with the configured language', () => {
    expect(contentToNcco({ type: 'text', text: 'Order shipped' }, { language: 'en-GB' })).toEqual([
      { action: 'talk', text: 'Order shipped', language: 'en-GB' },
    ]);
  });

  it('streams audio from a URL and refuses an uploaded ref', () => {
    expect(
      contentToNcco(
        { type: 'audio', mediaRef: { kind: 'url', value: 'https://cdn.example.com/a.mp3' } },
        { language: 'en-US' },
      ),
    ).toEqual([{ action: 'stream', streamUrl: ['https://cdn.example.com/a.mp3'] }]);

    expect(
      contentToNcco(
        { type: 'audio', mediaRef: { kind: 'platform-id', value: 'abc' } },
        { language: 'en-US' },
      ),
    ).toBeNull();
  });

  it('turns buttons into keypad digits, because a phone has no screen', () => {
    const ncco = contentToNcco(
      {
        type: 'interactive',
        text: 'How can we help?',
        buttons: [
          { id: 'sales', label: 'sales' },
          { id: 'support', label: 'support' },
        ],
      },
      { language: 'en-US' },
    )!;

    expect(ncco[0]).toMatchObject({
      action: 'talk',
      text: 'How can we help? Press 1 for sales. Press 2 for support.',
    });
    expect(ncco[1]).toMatchObject({ action: 'input', type: ['dtmf'] });
  });

  it('refuses content a phone call cannot carry', () => {
    expect(
      contentToNcco(
        { type: 'image', mediaRef: { kind: 'url', value: 'https://x/a.png' } },
        { language: 'en-US' },
      ),
    ).toBeNull();
  });
});

describe('respond', () => {
  it('produces an NCCO per request, with no shared state', () => {
    const adapter = createVonageVoiceAdapter({
      ...config,
      respond: (message) => [
        { action: 'talk', text: `Hello ${message.contact.channelUserId}` },
      ],
    });

    const a = adapter.getInteractionAck!(req({ uuid: 'c1', from: '1111', to: '15551234567' }));
    const b = adapter.getInteractionAck!(req({ uuid: 'c2', from: '2222', to: '15551234567' }));

    // Each caller must hear their own reply, not the previous caller's.
    expect(JSON.parse(a!)[0].text).toBe('Hello 1111');
    expect(JSON.parse(b!)[0].text).toBe('Hello 2222');
  });

  it('falls through when no responder is configured', () => {
    expect(createVonageVoiceAdapter(config).getInteractionAck!(req({ uuid: 'c', from: '1' }))).toBeNull();
  });
});

describe('inbound', () => {
  it('surfaces a keypad press as an interaction', async () => {
    const messages = await createVonageVoiceAdapter(config).handleWebhook(
      req({ uuid: 'c1', from: '1111', to: '15551234567', dtmf: { digits: '2' } }),
    );

    expect(messages[0]!.interaction?.data).toBe('2');
    expect(messages[0]!.externalId).toBe('c1');
    expect(messages[0]!.metadata?.callUuid).toBe('c1');
  });

  it('ignores a terminal call event, which is a receipt not a message', async () => {
    const messages = await createVonageVoiceAdapter(config).handleWebhook(
      req({ uuid: 'c1', from: '1111', status: 'completed' }),
    );
    expect(messages).toEqual([]);
  });
});

describe('parseStatuses', () => {
  it('maps call progress and only suppresses a failed or rejected call', () => {
    const adapter = createVonageVoiceAdapter(config);

    expect(adapter.parseStatuses({ uuid: 'c', status: 'ringing' })[0]!.status).toBe('sent');
    expect(adapter.parseStatuses({ uuid: 'c', status: 'answered' })[0]!.status).toBe('delivered');
    expect(adapter.parseStatuses({ uuid: 'c', status: 'completed' })[0]!.status).toBe('read');

    const failed = adapter.parseStatuses({ uuid: 'c', status: 'rejected', to: '15559999999' })[0]!;
    expect(failed.error?.code).toBe('vonage_voice_rejected');
    expect(failed.error?.permanent).toBe(true);
    expect(failed.recipientId).toBe('15559999999');
  });

  it('never suppresses on busy or unanswered', () => {
    const adapter = createVonageVoiceAdapter(config);
    for (const status of ['busy', 'unanswered', 'timeout', 'cancelled']) {
      const receipt = adapter.parseStatuses({ uuid: 'c', status })[0]!;
      expect(receipt.error?.permanent).toBe(false);
      expect(receipt.error?.retryable).toBe(true);
    }
  });

  it('ignores a status it does not recognise', () => {
    expect(createVonageVoiceAdapter(config).parseStatuses({ uuid: 'c', status: 'x' })).toEqual([]);
    expect(mapVonageCallStatus(undefined)).toBeNull();
    expect(classifyVonageCallStatus('answered')).toEqual({});
  });
});

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const outbound = (content: unknown, metadata?: unknown) =>
    ({
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'vonage-voice' as const,
      account: { channel: 'vonage-voice' as const, channelAccountId: '15551234567' },
      contact: { channel: 'vonage-voice' as const, channelUserId: '15559999999' },
      content,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    }) as Parameters<ReturnType<typeof createVonageVoiceAdapter>['send']>[0];

  it('transfers a live call to an inline NCCO', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { status: 200, ok: true, json: async () => ({}) } as unknown as Response;
    }) as unknown as typeof fetch;

    const receipt = await createVonageVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'transferring you now' }, { callUuid: 'c1' }),
    );

    expect(receipt.status).toBe('sent');
    expect(calls[0]!.url).toBe('https://vonage.test.local/v1/calls/c1');
    expect(calls[0]!.init!.method).toBe('PUT');
    // Vonage takes the NCCO inline, so nothing extra has to be hosted.
    expect(JSON.parse(calls[0]!.init!.body as string)).toEqual({
      action: 'transfer',
      destination: {
        type: 'ncco',
        ncco: [{ action: 'talk', text: 'transferring you now', language: 'en-US' }],
      },
    });
  });

  it('refuses without a call uuid rather than guessing', async () => {
    const receipt = await createVonageVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.error?.code).toBe('vonage_voice_missing_call_uuid');
    expect(receipt.error?.message).toContain('config.respond');
  });

  it('refuses content a call cannot carry', async () => {
    const receipt = await createVonageVoiceAdapter(config).send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'https://x/a.png' } }, { callUuid: 'c' }),
    );
    expect(receipt.error?.code).toBe('vonage_voice_unsupported_content');
    expect(receipt.error?.retryable).toBe(false);
  });

  it('reports a transfer rejected by Vonage', async () => {
    globalThis.fetch = vi.fn(async () =>
      ({ status: 404, ok: false, json: async () => ({ title: 'Call not found' }) }) as unknown as Response,
    ) as unknown as typeof fetch;

    const receipt = await createVonageVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }, { callUuid: 'gone' }),
    );
    expect(receipt.error?.code).toBe('vonage_voice_transfer_failed');
    expect(receipt.error?.message).toContain('Call not found');
  });
});

describe('initiateCall', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  it('strips the leading + Vonage does not accept', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      calls.push({ init });
      return { status: 201, ok: true, json: async () => ({ uuid: 'c9' }) } as unknown as Response;
    }) as unknown as typeof fetch;

    const { uuid } = await createVonageVoiceAdapter(config).initiateCall('+15559999999', {
      ncco: [{ action: 'talk', text: 'hi' }],
    });

    expect(uuid).toBe('c9');
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.to).toEqual([{ type: 'phone', number: '15559999999' }]);
    expect(body.from).toEqual({ type: 'phone', number: '15551234567' });
  });

  it('insists on being told what to do when the call connects', async () => {
    await expect(createVonageVoiceAdapter(config).initiateCall('15559999999')).rejects.toThrow(
      /ncco or options.answerUrl/,
    );
  });
});

describe('verifyCredentials', () => {
  it('points at the right credentials, not the SMS ones', async () => {
    const result = await createVonageVoiceAdapter({
      ...config,
      applicationId: '',
    }).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('vonage-sms');
  });
});
