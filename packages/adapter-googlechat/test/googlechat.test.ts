import { createSign, generateKeyPairSync } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  createGoogleChatAdapter,
  createServiceAccountJwt,
  pemToDer,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

/** Real RSA keypair, so the JWT paths exercise actual crypto. */
const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKeyPem = privateKey.export({ type: 'pkcs8', format: 'pem' }).toString();
const publicJwk = publicKey.export({ format: 'jwk' }) as { n: string; e: string };

const TOKEN_URL = 'https://token.test.local/token';
const JWKS_URL = 'https://jwks.test.local/keys';
const PROJECT_NUMBER = '1234567890';

const baseConfig = {
  serviceAccountEmail: 'bot@proj.iam.gserviceaccount.com',
  privateKey: privateKeyPem,
  projectNumber: PROJECT_NUMBER,
  defaultSpace: 'spaces/DEFAULT',
  apiBase: 'https://chat.test.local',
  tokenUrl: TOKEN_URL,
  jwksUrl: JWKS_URL,
};

const account = { channel: 'googlechat' as const, channelAccountId: 'spaces/AAA' };
const contact = { channel: 'googlechat' as const, channelUserId: 'spaces/AAA' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function b64url(input: string): string {
  return Buffer.from(input).toString('base64url');
}

/** Build a Google-style inbound bearer JWT signed with our test key. */
function makeInboundJwt(
  overrides: Record<string, unknown> = {},
  kid = 'test-kid',
  alg = 'RS256',
): string {
  const now = Math.floor(Date.now() / 1000);
  const header = b64url(JSON.stringify({ alg, kid, typ: 'JWT' }));
  const claims = b64url(
    JSON.stringify({
      iss: 'chat@system.gserviceaccount.com',
      aud: PROJECT_NUMBER,
      exp: now + 600,
      iat: now,
      ...overrides,
    }),
  );
  const signer = createSign('RSA-SHA256');
  signer.update(`${header}.${claims}`);
  const sig = signer.sign(privateKey).toString('base64url');
  return `${header}.${claims}.${sig}`;
}

/**
 * Mock covering the three endpoints the adapter touches: JWKS, the OAuth token
 * exchange, and the Chat API itself.
 */
function mockAll(opts: {
  chat?: unknown;
  chatStatus?: number;
  token?: unknown;
  tokenStatus?: number;
} = {}) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });

    if (url === JWKS_URL) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          keys: [{ kid: 'test-kid', kty: 'RSA', alg: 'RS256', n: publicJwk.n, e: publicJwk.e }],
        }),
      } as Response;
    }
    if (url === TOKEN_URL) {
      return {
        ok: (opts.tokenStatus ?? 200) < 400,
        status: opts.tokenStatus ?? 200,
        json: async () => opts.token ?? { access_token: 'ya29.test', expires_in: 3600 },
      } as Response;
    }
    return {
      ok: (opts.chatStatus ?? 200) < 400,
      status: opts.chatStatus ?? 200,
      json: async () => opts.chat ?? { name: 'spaces/AAA/messages/MSG1' },
    } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createGoogleChatAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'googlechat' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function webhook(body: unknown, headers: Record<string, string> = {}) {
  return { headers, rawBody: encode(JSON.stringify(body)), body, query: {} };
}

describe('createGoogleChatAdapter', () => {
  it('declares the googlechat channel and its capabilities', () => {
    const a = createGoogleChatAdapter(baseConfig);
    expect(a.channel).toBe('googlechat');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.interactive.buttons).toBe(true);
    // Bots link files rather than uploading through the messages API.
    expect(a.capabilities.media.file).toBe(false);
  });

  it('exchanges a signed service-account JWT for an access token', async () => {
    const calls = mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    expect(await a.getAccessToken()).toBe('ya29.test');

    const tokenCall = calls.find((c) => c.url === TOKEN_URL)!;
    const form = new URLSearchParams(tokenCall.init!.body as string);
    expect(form.get('grant_type')).toBe('urn:ietf:params:oauth:grant-type:jwt-bearer');

    // The assertion must be a real RS256 JWT for our service account.
    const assertion = form.get('assertion')!;
    const [header, claims] = assertion.split('.');
    expect(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg).toBe('RS256');
    const parsed = JSON.parse(Buffer.from(claims!, 'base64url').toString());
    expect(parsed.iss).toBe('bot@proj.iam.gserviceaccount.com');
    expect(parsed.aud).toBe(TOKEN_URL);
    expect(parsed.scope).toContain('chat.bot');
  });

  it('caches the access token across calls', async () => {
    const calls = mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    await a.getAccessToken();
    await a.getAccessToken();
    await a.getAccessToken();

    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('collapses concurrent token refreshes into one request', async () => {
    const calls = mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    await Promise.all([a.getAccessToken(), a.getAccessToken(), a.getAccessToken()]);

    expect(calls.filter((c) => c.url === TOKEN_URL)).toHaveLength(1);
  });

  it('sends a text message to the space', async () => {
    const calls = mockAll();
    const a = createGoogleChatAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hello space' }));

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('spaces/AAA/messages/MSG1');

    const chatCall = calls.find((c) => c.url.includes('/messages'))!;
    expect(chatCall.url).toContain('/v1/spaces/AAA/messages');
    expect((chatCall.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer ya29.test',
    );
    expect(JSON.parse(chatCall.init!.body as string).text).toBe('hello space');
  });

  it('replies in-thread and sets the reply option', async () => {
    const calls = mockAll();
    const a = createGoogleChatAdapter(baseConfig);
    await a.send(
      outbound({ type: 'text', text: 'reply' }, {
        metadata: { threadName: 'spaces/AAA/threads/T1' },
      }),
    );

    const chatCall = calls.find((c) => c.url.includes('/messages'))!;
    // Without messageReplyOption a threaded reply silently starts a new thread.
    expect(chatCall.url).toContain('messageReplyOption=REPLY_MESSAGE_FALLBACK_TO_NEW_THREAD');
    expect(JSON.parse(chatCall.init!.body as string).thread).toEqual({
      name: 'spaces/AAA/threads/T1',
    });
  });

  it('renders interactive buttons as a cardsV2 button list', async () => {
    const calls = mockAll();
    const a = createGoogleChatAdapter(baseConfig);
    await a.send(
      outbound({
        type: 'interactive',
        text: 'Deploy?',
        buttons: [[{ id: 'yes', label: 'Ship' }], [{ id: 'no', label: 'Wait' }]],
      }),
    );

    const body = JSON.parse(
      calls.find((c) => c.url.includes('/messages'))!.init!.body as string,
    );
    const buttons =
      body.cardsV2[0].card.sections[0].widgets[0].buttonList.buttons;
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text).toBe('Ship');
    expect(buttons[0].onClick.action.function).toBe('yes');
  });

  it('falls back to defaultSpace, and fails clearly with no space', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);
    const ok = await a.send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'googlechat', channelUserId: '' },
    });
    expect(ok.status).toBe('sent');

    const noSpace = createGoogleChatAdapter({ ...baseConfig, defaultSpace: undefined });
    const receipt = await noSpace.send({
      ...outbound({ type: 'text', text: 'hi' }),
      contact: { channel: 'googlechat', channelUserId: '' },
    });
    expect(receipt.error?.code).toBe('googlechat_missing_space');
  });

  it('surfaces a Chat API error', async () => {
    mockAll({
      chat: { error: { code: 403, status: 'PERMISSION_DENIED', message: 'Bot not in space' } },
      chatStatus: 403,
    });

    const a = createGoogleChatAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('googlechat_PERMISSION_DENIED');
    expect(receipt.error?.message).toBe('Bot not in space');
  });

  it('reports a token exchange failure as an auth error', async () => {
    mockAll({
      token: { error: 'invalid_grant', error_description: 'Invalid JWT Signature' },
      tokenStatus: 400,
    });

    const a = createGoogleChatAdapter(baseConfig);
    const receipt = await a.send(outbound({ type: 'text', text: 'hi' }));

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('googlechat_auth_error');
    expect(receipt.error?.message).toContain('Invalid JWT Signature');
  });

  it('rejects unsupported content with guidance', async () => {
    const a = createGoogleChatAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'https://x/y.png' } }),
    );
    expect(receipt.error?.code).toBe('googlechat_unsupported_content');
    expect(receipt.error?.message).toContain('linking');
  });

  it('parses an inbound MESSAGE event, preferring argumentText', async () => {
    const a = createGoogleChatAdapter(baseConfig);
    const messages = await a.handleWebhook(
      webhook({
        type: 'MESSAGE',
        eventTime: '2026-01-01T10:00:00.000Z',
        space: { name: 'spaces/AAA' },
        message: {
          name: 'spaces/AAA/messages/M1',
          text: '@bot deploy prod',
          argumentText: ' deploy prod',
          thread: { name: 'spaces/AAA/threads/T1' },
          sender: { name: 'users/123', displayName: 'Alice', type: 'HUMAN' },
        },
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    // argumentText strips the @mention, which is what a bot actually wants.
    expect((m.content as { text: string }).text).toBe('deploy prod');
    expect(m.contact.channelUserId).toBe('spaces/AAA');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.metadata?.threadName).toBe('spaces/AAA/threads/T1');
    expect(m.metadata?.userId).toBe('users/123');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('surfaces CARD_CLICKED as an interaction', async () => {
    const a = createGoogleChatAdapter(baseConfig);
    const [m] = await a.handleWebhook(
      webhook({
        type: 'CARD_CLICKED',
        space: { name: 'spaces/AAA' },
        user: { name: 'users/9', displayName: 'Bob', type: 'HUMAN' },
        common: { invokedFunction: 'approve' },
      }),
    );

    expect(m!.interaction?.data).toBe('approve');
    expect((m!.content as { text: string }).text).toBe('approve');
  });

  it('ignores lifecycle events and the bot’s own messages', async () => {
    const a = createGoogleChatAdapter(baseConfig);

    expect(
      await a.handleWebhook(
        webhook({ type: 'ADDED_TO_SPACE', space: { name: 'spaces/AAA' } }),
      ),
    ).toEqual([]);

    expect(
      await a.handleWebhook(
        webhook({
          type: 'MESSAGE',
          space: { name: 'spaces/AAA' },
          message: { text: 'echo', sender: { name: 'users/bot', type: 'BOT' } },
        }),
      ),
    ).toEqual([]);
  });

  it('verifies a genuine Google-signed bearer token', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    expect(
      await a.verifySignature(webhook({}, { authorization: `Bearer ${makeInboundJwt()}` })),
    ).toBe(true);
  });

  it('rejects a token for the wrong project (aud mismatch)', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    expect(
      await a.verifySignature(
        webhook({}, { authorization: `Bearer ${makeInboundJwt({ aud: '999' })}` }),
      ),
    ).toBe(false);
  });

  it('rejects a token from the wrong issuer', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    expect(
      await a.verifySignature(
        webhook({}, { authorization: `Bearer ${makeInboundJwt({ iss: 'evil@x.com' })}` }),
      ),
    ).toBe(false);
  });

  it('rejects an expired token', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);
    const expired = makeInboundJwt({ exp: Math.floor(Date.now() / 1000) - 10_000 });

    expect(
      await a.verifySignature(webhook({}, { authorization: `Bearer ${expired}` })),
    ).toBe(false);
  });

  it('rejects alg:none, blocking algorithm confusion', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);
    const now = Math.floor(Date.now() / 1000);
    const header = b64url(JSON.stringify({ alg: 'none', kid: 'test-kid', typ: 'JWT' }));
    const claims = b64url(
      JSON.stringify({
        iss: 'chat@system.gserviceaccount.com',
        aud: PROJECT_NUMBER,
        exp: now + 600,
      }),
    );

    expect(
      await a.verifySignature(
        webhook({}, { authorization: `Bearer ${header}.${claims}.` }),
      ),
    ).toBe(false);
  });

  it('rejects a malformed or missing Authorization header', async () => {
    mockAll();
    const a = createGoogleChatAdapter(baseConfig);

    expect(await a.verifySignature(webhook({}, {}))).toBe(false);
    expect(
      await a.verifySignature(webhook({}, { authorization: 'Bearer not-a-jwt' })),
    ).toBe(false);
  });

  it('skips verification when no project number is configured', async () => {
    const a = createGoogleChatAdapter({ ...baseConfig, projectNumber: undefined });
    expect(await a.verifySignature(webhook({}, {}))).toBe(true);
  });

  it('verifyCredentials succeeds when the token exchange works', async () => {
    mockAll();
    const result = await createGoogleChatAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('bot@proj');
  });

  it('verifyCredentials reports a rejected assertion as unauthorized', async () => {
    mockAll({
      token: { error: 'invalid_grant', error_description: 'invalid_grant: bad key' },
      tokenStatus: 400,
    });

    const result = await createGoogleChatAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('Chat API is enabled');
    }
  });

  it('verifyCredentials explains an unparseable private key', async () => {
    mockAll();
    const result = await createGoogleChatAdapter({
      ...baseConfig,
      privateKey: '-----BEGIN PRIVATE KEY-----\nbm90LWEta2V5\n-----END PRIVATE KEY-----',
    }).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('JSON key file');
  });

  it('verifyCredentials returns a hint when config is missing', async () => {
    const result = await createGoogleChatAdapter({
      ...baseConfig,
      privateKey: '',
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('private_key');
  });
});

describe('pemToDer', () => {
  it('decodes a normal PEM', () => {
    expect(pemToDer(privateKeyPem).length).toBeGreaterThan(100);
  });

  it('handles escaped \\n, as env vars deliver them', () => {
    const escaped = privateKeyPem.replace(/\n/g, '\\n');
    expect(pemToDer(escaped)).toEqual(pemToDer(privateKeyPem));
  });
});

describe('createServiceAccountJwt', () => {
  it('produces a JWT that verifies against the public key', async () => {
    const jwt = await createServiceAccountJwt({
      email: 'a@b.com',
      privateKeyPem,
      scope: 'scope',
      audience: 'aud',
      nowSec: 1_700_000_000,
    });

    const [h, c, s] = jwt.split('.');
    const verifier = createSign('RSA-SHA256');
    verifier.update(`${h}.${c}`);
    // Round-trip the signature through Node to confirm it is valid RS256.
    const expected = verifier.sign(privateKey).toString('base64url');
    expect(s).toBe(expected);

    const claims = JSON.parse(Buffer.from(c!, 'base64url').toString());
    expect(claims).toMatchObject({ iss: 'a@b.com', aud: 'aud', exp: 1_700_003_600 });
  });
});
