import { afterEach, describe, expect, it, vi } from 'vitest';

import { createMsTeamsAdapter } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

function bytesToB64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary).replace(/=+$/g, '').replace(/\+/g, '-').replace(/\//g, '_');
}

function jsonToB64url(obj: unknown): string {
  return bytesToB64url(encode(JSON.stringify(obj)));
}

const baseConfig = {
  appId: '00000000-0000-0000-0000-000000000000',
  appPassword: 'super-secret',
  jwksUrl: 'https://test.example/jwks',
  tokenUrl: 'https://test.example/token',
};

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('createMsTeamsAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createMsTeamsAdapter(baseConfig);
    expect(a.channel).toBe('msteams');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.interactive.buttons).toBe(true);
    expect(a.capabilities.templates).toBe(false);
  });

  it('parses an inbound text activity, surfacing serviceUrl + tenantId in metadata', async () => {
    const a = createMsTeamsAdapter(baseConfig);
    const activity = {
      type: 'message',
      id: 'activity-1',
      serviceUrl: 'https://smba.trafficmanager.net/amer/',
      channelId: 'msteams',
      timestamp: '2026-05-11T13:00:00.000Z',
      from: { id: '29:user', name: 'Ayush', aadObjectId: 'aad-123' },
      recipient: { id: '28:bot' },
      conversation: {
        id: 'a:conv-xyz',
        conversationType: 'personal',
        tenantId: 'tenant-9',
      },
      text: 'hi teams',
    };

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: activity,
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('msteams');
    expect((m.content as { text: string }).text).toBe('hi teams');
    expect(m.contact.channelUserId).toBe('a:conv-xyz');
    expect(m.contact.displayName).toBe('Ayush');
    expect(m.account.channelAccountId).toBe('28:bot');
    expect(m.metadata?.serviceUrl).toBe('https://smba.trafficmanager.net/amer/');
    expect(m.metadata?.tenantId).toBe('tenant-9');
    expect(m.metadata?.conversationType).toBe('personal');
  });

  it('ignores non-message activity types (conversationUpdate, etc.)', async () => {
    const a = createMsTeamsAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { type: 'conversationUpdate', conversation: { id: 'c' } },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('treats card-action invocations (value-only activities) as text', async () => {
    const a = createMsTeamsAdapter(baseConfig);
    const activity = {
      type: 'message',
      conversation: { id: 'a:conv' },
      recipient: { id: '28:bot' },
      from: { id: '29:u', name: 'Tester' },
      value: { text: 'yes_clicked' },
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: activity,
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('yes_clicked');
  });

  it('send fails with a clear error when metadata.serviceUrl is missing', async () => {
    const a = createMsTeamsAdapter(baseConfig);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'msteams',
      account: { channel: 'msteams', channelAccountId: '28:bot' },
      contact: { channel: 'msteams', channelUserId: 'a:conv' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });
    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('msteams_missing_service_url');
  });

  it('verifyCredentials returns hint when appPassword is empty', async () => {
    const a = createMsTeamsAdapter({ ...baseConfig, appPassword: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('client secret');
    }
  });

  it('verifySignature rejects requests without an Authorization header', async () => {
    const a = createMsTeamsAdapter(baseConfig);
    const ok = await a.verifySignature({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(ok).toBe(false);
  });

  it('verifySignature verifies a real RS256 JWT against a mocked JWKS', async () => {
    let keyPair: CryptoKeyPair;
    try {
      keyPair = (await globalThis.crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
    } catch {
      console.warn('Skipping JWT test: WebCrypto RSASSA-PKCS1-v1_5 unavailable');
      return;
    }

    const jwk = (await globalThis.crypto.subtle.exportKey(
      'jwk',
      keyPair.publicKey,
    )) as Record<string, unknown>;
    jwk.kid = 'test-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    const header = jsonToB64url({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
    const payload = jsonToB64url({
      iss: 'https://api.botframework.com',
      aud: baseConfig.appId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      nbf: Math.floor(Date.now() / 1000) - 60,
    });
    const signedInput = `${header}.${payload}`;
    const sigBytes = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keyPair.privateKey,
        encode(signedInput) as BufferSource,
      ),
    );
    const jwt = `${signedInput}.${bytesToB64url(sigBytes)}`;

    const fetchMock = vi.fn().mockImplementation(async (url: string) => {
      if (url === baseConfig.jwksUrl) {
        return {
          ok: true,
          status: 200,
          json: async () => ({ keys: [jwk] }),
        } as Response;
      }
      throw new Error(`unexpected fetch: ${url}`);
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const a = createMsTeamsAdapter(baseConfig);

    const ok = await a.verifySignature({
      headers: { authorization: `Bearer ${jwt}` },
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(ok).toBe(true);

    // Tamper the payload — signature must no longer verify.
    const tamperedPayload = jsonToB64url({
      iss: 'https://api.botframework.com',
      aud: baseConfig.appId,
      exp: Math.floor(Date.now() / 1000) + 3600,
      extra: 'malicious',
    });
    const tamperedJwt = `${header}.${tamperedPayload}.${bytesToB64url(sigBytes)}`;
    const bad = await a.verifySignature({
      headers: { authorization: `Bearer ${tamperedJwt}` },
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(bad).toBe(false);
  });

  it('verifySignature rejects a JWT with the wrong audience claim', async () => {
    let keyPair: CryptoKeyPair;
    try {
      keyPair = (await globalThis.crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-256',
        },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
    } catch {
      return;
    }

    const jwk = (await globalThis.crypto.subtle.exportKey(
      'jwk',
      keyPair.publicKey,
    )) as Record<string, unknown>;
    jwk.kid = 'test-kid';
    jwk.alg = 'RS256';
    jwk.use = 'sig';

    const header = jsonToB64url({ alg: 'RS256', kid: 'test-kid', typ: 'JWT' });
    const payload = jsonToB64url({
      iss: 'https://api.botframework.com',
      aud: 'some-other-app-id',
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        'RSASSA-PKCS1-v1_5',
        keyPair.privateKey,
        encode(`${header}.${payload}`) as BufferSource,
      ),
    );
    const jwt = `${header}.${payload}.${bytesToB64url(sig)}`;

    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      json: async () => ({ keys: [jwk] }),
    } as Response) as unknown as typeof fetch;

    const a = createMsTeamsAdapter(baseConfig);
    const ok = await a.verifySignature({
      headers: { authorization: `Bearer ${jwt}` },
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(ok).toBe(false);
  });
});
