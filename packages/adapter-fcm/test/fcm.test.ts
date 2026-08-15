import { createSign, generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createFcmAdapter,
  createServiceAccountJwt,
  isPermanentFcmError,
  pemToDer,
} from '../src/index.js';

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();

const TOKEN_URL = 'https://token.test.local/token';

const baseConfig = {
  projectId: 'acme-app',
  serviceAccountEmail: 'fcm@acme-app.iam.gserviceaccount.com',
  privateKey: privateKeyPem,
  apiBase: 'https://fcm.test.local',
  tokenUrl: TOKEN_URL,
};

const account = { channel: 'fcm' as const, channelAccountId: 'acme-app' };
const contact = { channel: 'fcm' as const, channelUserId: 'device-token-abc' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockAll(opts: { send?: unknown; sendStatus?: number; token?: unknown } = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    if (url === TOKEN_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => opts.token ?? { access_token: 'ya29.fcm', expires_in: 3600 },
      } as Response;
    }
    return {
      ok: (opts.sendStatus ?? 200) < 400,
      status: opts.sendStatus ?? 200,
      json: async () =>
        opts.send ?? { name: 'projects/acme-app/messages/0:123' },
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createFcmAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'fcm' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

describe('createFcmAdapter', () => {
  it('declares the fcm channel and push-shaped capabilities', () => {
    const a = createFcmAdapter(baseConfig);
    expect(a.channel).toBe('fcm');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
    // Push is one-way and carries no files.
    expect(a.capabilities.media.file).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(false);
  });

  it('sends a notification to a device token', async () => {
    const calls = mockAll();
    const a = createFcmAdapter({ ...baseConfig, defaultTitle: 'Acme' });
    const receipt = await a.send(outbound({ type: 'text', text: 'Your order shipped' }));

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('projects/acme-app/messages/0:123');

    const sendCall = calls.find((c) => c.url.includes('messages:send'))!;
    expect(sendCall.url).toBe('https://fcm.test.local/v1/projects/acme-app/messages:send');
    expect((sendCall.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.fcm',
    );

    const { message } = JSON.parse(sendCall.init!.body as string);
    expect(message.token).toBe('device-token-abc');
    expect(message.notification).toEqual({ title: 'Acme', body: 'Your order shipped' });
  });

  it('lets metadata override the title and attach data', async () => {
    const calls = mockAll();
    const a = createFcmAdapter({ ...baseConfig, defaultTitle: 'Acme' });
    await a.send(
      outbound({ type: 'text', text: 'body' }, {
        metadata: { title: 'Custom', data: { orderId: '42' } },
      }),
    );

    const { message } = JSON.parse(
      calls.find((c) => c.url.includes('messages:send'))!.init!.body as string,
    );
    expect(message.notification.title).toBe('Custom');
    expect(message.data).toEqual({ orderId: '42' });
  });

  it('sends an image notification by URL', async () => {
    const calls = mockAll();
    await createFcmAdapter(baseConfig).send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://cdn.test/p.png' },
        caption: 'look',
      }),
    );

    const { message } = JSON.parse(
      calls.find((c) => c.url.includes('messages:send'))!.init!.body as string,
    );
    expect(message.notification.image).toBe('https://cdn.test/p.png');
    expect(message.notification.body).toBe('look');
  });

  it('refuses an image reference FCM cannot fetch', async () => {
    const calls = mockAll();
    const receipt = await createFcmAdapter(baseConfig).send(
      outbound({ type: 'image', mediaRef: { kind: 'platform-id', value: 'x' } }),
    );

    expect(receipt.error?.code).toBe('fcm_media_url_required');
    expect(calls.filter((c) => c.url.includes('messages:send'))).toHaveLength(0);
  });

  it('marks an unregistered token as a permanent failure', async () => {
    // An app uninstall leaves a token that fails forever — this is what lets
    // the suppression store retire it.
    mockAll({
      sendStatus: 404,
      send: {
        error: {
          code: 404,
          status: 'NOT_FOUND',
          message: 'Requested entity was not found.',
          details: [{ errorCode: 'UNREGISTERED' }],
        },
      },
    });

    const receipt = await createFcmAdapter(baseConfig).send(
      outbound({ type: 'text', text: 'x' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('fcm_UNREGISTERED');
    expect(receipt.error?.permanent).toBe(true);
  });

  it('treats a server error or quota failure as retryable', async () => {
    mockAll({
      sendStatus: 503,
      send: { error: { code: 503, status: 'UNAVAILABLE', message: 'try again' } },
    });

    const receipt = await createFcmAdapter(baseConfig).send(
      outbound({ type: 'text', text: 'x' }),
    );
    expect(receipt.error?.permanent).toBe(false);
  });

  it('reports a token exchange failure as an auth error', async () => {
    mockAll({ token: { error: 'invalid_grant', error_description: 'bad key' } });

    const receipt = await createFcmAdapter(baseConfig).send(
      outbound({ type: 'text', text: 'x' }),
    );
    expect(receipt.error?.code).toBe('fcm_auth_error');
    expect(receipt.error?.message).toContain('bad key');
  });

  it('fails clearly when no device token is supplied', async () => {
    mockAll();
    const receipt = await createFcmAdapter(baseConfig).send({
      ...outbound({ type: 'text', text: 'x' }),
      contact: { channel: 'fcm', channelUserId: '' },
    });

    expect(receipt.error?.code).toBe('fcm_missing_token');
    expect(receipt.error?.message).toContain('sendToTopic');
  });

  it('rejects unsupported content', async () => {
    const receipt = await createFcmAdapter(baseConfig).send(
      outbound({ type: 'location', latitude: 1, longitude: 2 }),
    );
    expect(receipt.error?.code).toBe('fcm_unsupported_content');
  });

  it('broadcasts to a topic, stripping the legacy /topics/ prefix', async () => {
    const calls = mockAll();
    const a = createFcmAdapter(baseConfig);
    const receipt = await a.sendToTopic('/topics/news', { body: 'Big news', title: 'Acme' });

    expect(receipt.status).toBe('sent');
    const { message } = JSON.parse(
      calls.find((c) => c.url.includes('messages:send'))!.init!.body as string,
    );
    // The v1 API rejects the prefixed form.
    expect(message.topic).toBe('news');
    expect(message.token).toBeUndefined();
    expect(message.notification.body).toBe('Big news');
  });

  it('caches the access token and collapses concurrent refreshes', async () => {
    const calls = mockAll();
    const a = createFcmAdapter(baseConfig);

    await Promise.all([a.getAccessToken(), a.getAccessToken(), a.getAccessToken()]);
    await a.getAccessToken();

    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('returns nothing from handleWebhook, since push is one-way', async () => {
    const a = createFcmAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: new TextEncoder().encode('{}'),
      body: {},
      query: {},
    });
    expect(messages).toEqual([]);
  });

  it('rejects media operations with an explanation', async () => {
    const a = createFcmAdapter(baseConfig);
    await expect(
      a.uploadMedia({ data: new TextEncoder().encode('x'), mimeType: 'image/png' }),
    ).rejects.toThrow('no media upload');
    await expect(a.downloadMedia({ kind: 'url', value: 'x' })).rejects.toThrow('one-way');
  });

  it('verifyCredentials succeeds when the token exchange works', async () => {
    mockAll();
    const result = await createFcmAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('acme-app');
  });

  it('verifyCredentials reports a rejected service account', async () => {
    mockAll({ token: { error: 'invalid_grant', error_description: 'invalid_grant' } });
    const result = await createFcmAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('Firebase Cloud Messaging API');
    }
  });

  it('verifyCredentials explains an unparseable private key', async () => {
    mockAll();
    const result = await createFcmAdapter({
      ...baseConfig,
      privateKey: '-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----',
    }).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('verbatim');
  });

  it('verifyCredentials returns a hint when config is missing', async () => {
    const result = await createFcmAdapter({
      ...baseConfig,
      privateKey: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Service accounts');
  });
});

describe('createServiceAccountJwt', () => {
  it('produces a JWT that verifies against the signing key', async () => {
    const jwt = await createServiceAccountJwt({
      email: 'a@b.com',
      privateKeyPem,
      scope: 'scope',
      audience: 'aud',
      nowSec: 1_700_000_000,
    });

    const [h, c, s] = jwt.split('.');
    const signer = createSign('RSA-SHA256');
    signer.update(`${h}.${c}`);
    expect(s).toBe(signer.sign(privateKey).toString('base64url'));

    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'a@b.com', aud: 'aud', exp: 1_700_003_600 });
  });
});

describe('pemToDer', () => {
  it('handles escaped \\n, as env vars deliver them', () => {
    expect(pemToDer(privateKeyPem.replace(/\n/g, '\\n'))).toEqual(pemToDer(privateKeyPem));
  });
});

describe('isPermanentFcmError', () => {
  it('treats dead-token errors as permanent and the rest as retryable', () => {
    expect(isPermanentFcmError('UNREGISTERED')).toBe(true);
    expect(isPermanentFcmError('SENDER_ID_MISMATCH')).toBe(true);
    expect(isPermanentFcmError('INVALID_ARGUMENT')).toBe(true);
    expect(isPermanentFcmError('UNAVAILABLE')).toBe(false);
    expect(isPermanentFcmError('QUOTA_EXCEEDED')).toBe(false);
    expect(isPermanentFcmError(undefined)).toBe(false);
  });
});
