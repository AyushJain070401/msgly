import { createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { createWeChatAdapter } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const config = {
  appId: 'wx-app-id',
  appSecret: 'app-secret',
  token: 'test-token',
  apiBase: 'https://api.test.local',
};

/**
 * WeChat signs with sha1 of [token, timestamp, nonce] sorted lexicographically
 * and concatenated. Computed here with Node's crypto so the test is an
 * independent check of the adapter's hand-rolled SHA-1 rather than a
 * restatement of it.
 */
function sign(token: string, timestamp: string, nonce: string): string {
  return createHash('sha1')
    .update([token, timestamp, nonce].sort().join(''))
    .digest('hex');
}

/** Signature verification enforces a freshness window, so this must be "now". */
const TIMESTAMP = String(Math.floor(Date.now() / 1000));
const NONCE = 'abc123';
const VALID_SIG = sign(config.token, TIMESTAMP, NONCE);

function inboundXml(fields: Record<string, string | number>): string {
  const body = Object.entries(fields)
    .map(([k, v]) =>
      typeof v === 'number' ? `<${k}>${v}</${k}>` : `<${k}><![CDATA[${v}]]></${k}>`,
    )
    .join('');
  return `<xml>${body}</xml>`;
}

function tokenResponse() {
  return {
    ok: true,
    status: 200,
    json: async () => ({ access_token: 'at-123456789', expires_in: 7200 }),
  } as Response;
}

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe('createWeChatAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createWeChatAdapter(config);
    expect(a.channel).toBe('wechat');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
    expect(a.capabilities.media.video).toBe(true);
    expect(a.capabilities.media.audio).toBe(true);
    // No generic file type exists in WeChat Official Account messaging.
    expect(a.capabilities.media.file).toBe(false);
    expect(a.capabilities.interactive.quickReplies).toBe(true);
    expect(a.capabilities.templates).toBe(false);
  });

  it('accepts a correctly signed webhook', async () => {
    const a = createWeChatAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: { signature: VALID_SIG, timestamp: TIMESTAMP, nonce: NONCE },
      }),
    ).toBe(true);
  });

  it('rejects a wrong signature', async () => {
    const a = createWeChatAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: { signature: 'f'.repeat(40), timestamp: TIMESTAMP, nonce: NONCE },
      }),
    ).toBe(false);
  });

  it('rejects a signature computed with a different token', async () => {
    const a = createWeChatAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {
          signature: sign('wrong-token', TIMESTAMP, NONCE),
          timestamp: TIMESTAMP,
          nonce: NONCE,
        },
      }),
    ).toBe(false);
  });

  it('rejects a webhook missing signature parameters', async () => {
    const a = createWeChatAdapter(config);
    for (const query of [
      {},
      { signature: VALID_SIG },
      { signature: VALID_SIG, timestamp: TIMESTAMP },
      { timestamp: TIMESTAMP, nonce: NONCE },
    ]) {
      expect(
        await a.verifySignature({
          headers: {},
          rawBody: encode(''),
          body: {},
          query,
        }),
      ).toBe(false);
    }
  });

  it('rejects a stale signature, bounding webhook replay', async () => {
    const a = createWeChatAdapter(config);
    // WeChat's signature does not cover the request body, so without a
    // freshness window one captured triple would stay valid forever and could
    // be replayed with any payload.
    const staleTs = String(Math.floor(Date.now() / 1000) - 3600);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {
          signature: sign(config.token, staleTs, NONCE),
          timestamp: staleTs,
          nonce: NONCE,
        },
      }),
    ).toBe(false);
  });

  it('rejects a non-numeric timestamp', async () => {
    const a = createWeChatAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {
          signature: sign(config.token, 'not-a-number', NONCE),
          timestamp: 'not-a-number',
          nonce: NONCE,
        },
      }),
    ).toBe(false);
  });

  it('honours maxTimestampSkewSec: 0 as an explicit opt-out', async () => {
    const a = createWeChatAdapter({ ...config, maxTimestampSkewSec: 0 });
    const staleTs = '1700000000';
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {
          signature: sign(config.token, staleTs, NONCE),
          timestamp: staleTs,
          nonce: NONCE,
        },
      }),
    ).toBe(true);
  });

  it('echoes echostr on a valid GET challenge and refuses an invalid one', () => {
    const a = createWeChatAdapter(config);

    expect(
      a.verifyWebhookChallenge?.({
        signature: VALID_SIG,
        timestamp: TIMESTAMP,
        nonce: NONCE,
        echostr: 'challenge-me',
      }),
    ).toBe('challenge-me');

    expect(
      a.verifyWebhookChallenge?.({
        signature: 'f'.repeat(40),
        timestamp: TIMESTAMP,
        nonce: NONCE,
        echostr: 'challenge-me',
      }),
    ).toBeNull();

    // Missing echostr is not a challenge request at all.
    expect(
      a.verifyWebhookChallenge?.({
        signature: VALID_SIG,
        timestamp: TIMESTAMP,
        nonce: NONCE,
      }),
    ).toBeNull();
  });

  it('parses an inbound text message from CDATA XML', async () => {
    const a = createWeChatAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(
        inboundXml({
          ToUserName: 'gh_official_account',
          FromUserName: 'o_user_openid',
          CreateTime: 1700000000,
          MsgType: 'text',
          Content: 'hello from wechat',
          MsgId: '1234567890123456',
        }),
      ),
      body: {},
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('wechat');
    expect(m.direction).toBe('inbound');
    expect(m.content).toEqual({ type: 'text', text: 'hello from wechat' });
    expect(m.contact.channelUserId).toBe('o_user_openid');
    expect(m.account.channelAccountId).toBe('gh_official_account');
    expect(m.externalId).toBe('1234567890123456');
    expect(m.timestamp).toBe(new Date(1700000000 * 1000).toISOString());
  });

  it('parses an inbound image message, preferring PicUrl over MediaId', async () => {
    const a = createWeChatAdapter(config);
    const [m] = await a.handleWebhook({
      headers: {},
      rawBody: encode(
        inboundXml({
          ToUserName: 'gh_acct',
          FromUserName: 'o_user',
          CreateTime: 1700000000,
          MsgType: 'image',
          PicUrl: 'https://mmbiz.qpic.cn/pic.jpg',
          MediaId: 'media-abc',
          MsgId: '999',
        }),
      ),
      body: {},
      query: {},
    });

    expect(m!.content).toEqual({
      type: 'image',
      mediaRef: { kind: 'url', value: 'https://mmbiz.qpic.cn/pic.jpg' },
    });
  });

  it('maps an inbound voice message to audio content', async () => {
    const a = createWeChatAdapter(config);
    const [m] = await a.handleWebhook({
      headers: {},
      rawBody: encode(
        inboundXml({
          ToUserName: 'gh_acct',
          FromUserName: 'o_user',
          CreateTime: 1700000000,
          MsgType: 'voice',
          MediaId: 'voice-media-id',
        }),
      ),
      body: {},
      query: {},
    });

    expect(m!.content).toEqual({
      type: 'audio',
      mediaRef: { kind: 'platform-id', value: 'voice-media-id' },
    });
  });

  it('flattens an inbound link message into text', async () => {
    const a = createWeChatAdapter(config);
    const [m] = await a.handleWebhook({
      headers: {},
      rawBody: encode(
        inboundXml({
          ToUserName: 'gh_acct',
          FromUserName: 'o_user',
          CreateTime: 1700000000,
          MsgType: 'link',
          Title: 'Some article',
          Description: 'A description',
          Url: 'https://example.com/a',
        }),
      ),
      body: {},
      query: {},
    });

    expect(m!.content.type).toBe('text');
    expect((m!.content as { text: string }).text).toBe(
      'Some article\nA description\nhttps://example.com/a',
    );
  });

  it('sends a text message through the customer service API', async () => {
    let sendUrl = '';
    let sendBody: Record<string, unknown> | undefined;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      if (url.includes('/cgi-bin/token')) return tokenResponse();
      sendUrl = url;
      sendBody = JSON.parse((init?.body as string) ?? '{}');
      return { ok: true, status: 200, json: async () => ({ errcode: 0 }) } as Response;
    }) as unknown as typeof fetch;

    const a = createWeChatAdapter(config);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'wechat',
      account: { channel: 'wechat', channelAccountId: 'gh_acct' },
      contact: { channel: 'wechat', channelUserId: 'o_user' },
      content: { type: 'text', text: 'hello back' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.messageId).toBe('m-1');
    expect(sendUrl).toContain('/cgi-bin/message/custom/send?access_token=at-123456789');
    expect(sendBody).toEqual({
      touser: 'o_user',
      msgtype: 'text',
      text: { content: 'hello back' },
    });
  });

  it('rejects an image send that was given a URL instead of a media_id', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () => tokenResponse()) as unknown as typeof fetch;

    const a = createWeChatAdapter(config);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'wechat',
      account: { channel: 'wechat', channelAccountId: 'gh_acct' },
      contact: { channel: 'wechat', channelUserId: 'o_user' },
      content: {
        type: 'image',
        mediaRef: { kind: 'url', value: 'https://example.com/x.png' },
      },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('wechat_send_failed');
    expect(receipt.error?.message).toContain('uploadMedia');
  });

  it('surfaces a WeChat API error code as a failed receipt', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/cgi-bin/token')) return tokenResponse();
      return {
        ok: true,
        status: 200,
        json: async () => ({ errcode: 45015, errmsg: 'response out of time limit' }),
      } as Response;
    }) as unknown as typeof fetch;

    const a = createWeChatAdapter(config);
    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'wechat',
      account: { channel: 'wechat', channelAccountId: 'gh_acct' },
      contact: { channel: 'wechat', channelUserId: 'o_user' },
      content: { type: 'text', text: 'too late' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.message).toContain('45015');
  });

  it('caches the access token across calls', async () => {
    let tokenCalls = 0;
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      if (url.includes('/cgi-bin/token')) {
        tokenCalls++;
        return tokenResponse();
      }
      return { ok: true, status: 200, json: async () => ({ errcode: 0 }) } as Response;
    }) as unknown as typeof fetch;

    const a = createWeChatAdapter(config);
    expect(await a.getAccessToken()).toBe('at-123456789');
    await a.getAccessToken();
    await a.getAccessToken();
    expect(tokenCalls).toBe(1);
  });

  it('verifyCredentials succeeds when a token can be fetched', async () => {
    globalThis.fetch = vi
      .fn()
      .mockImplementation(async () => tokenResponse()) as unknown as typeof fetch;

    const result = await createWeChatAdapter(config).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('wx-app-id');
  });

  it('verifyCredentials returns a hint when appSecret is empty', async () => {
    const result = await createWeChatAdapter({ ...config, appSecret: '' }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('appSecret');
    }
  });

  it('verifyCredentials reports rejected credentials as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ errcode: 40001, errmsg: 'invalid credential' }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createWeChatAdapter(config).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      // The adapter surfaces WeChat's `errmsg`, which is what trips the
      // unauthorized branch.
      expect(result.hint).toContain('invalid credential');
      expect(result.hint).toContain('mp.weixin.qq.com');
    }
  });
});

describe('mass send', () => {
  function mockMass(payload: unknown) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      if (url.includes('/cgi-bin/token')) return tokenResponse();
      return { ok: true, status: 200, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  it('mass-sends text to all followers', async () => {
    const calls = mockMass({ errcode: 0, msg_id: 999 });
    const receipt = await createWeChatAdapter(config).massSend({
      type: 'text',
      text: 'New arrivals',
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('999');

    const call = calls.find((c) => c.url.includes('mass/sendall'))!;
    const body = JSON.parse(call.init!.body as string);
    expect(body.filter).toEqual({ is_to_all: true });
    expect(body.text).toEqual({ content: 'New arrivals' });
  });

  it('targets a tag group when given one', async () => {
    const calls = mockMass({ errcode: 0, msg_id: 1 });
    await createWeChatAdapter(config).massSend({ type: 'text', text: 'x' }, { tagId: 7 });

    const body = JSON.parse(calls.find((c) => c.url.includes('mass/sendall'))!.init!.body as string);
    expect(body.filter).toEqual({ is_to_all: false, tag_id: 7 });
  });

  it('explains an exhausted quota and marks it retryable', async () => {
    // 4 per month for Service Accounts — the quota clears, so this is not
    // a permanent failure.
    mockMass({ errcode: 45028, errmsg: 'reach max api daily quota limit' });
    const receipt = await createWeChatAdapter(config).massSend({ type: 'text', text: 'x' });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('wechat_45028');
    expect(receipt.error?.message).toContain('4/month');
    expect(receipt.error?.permanent).toBe(false);
  });

  it('mass-sends to an explicit openid list', async () => {
    const calls = mockMass({ errcode: 0, msg_id: 2 });
    const receipt = await createWeChatAdapter(config).massSendToUsers(
      ['o_1', 'o_2'],
      { type: 'text', text: 'hi' },
    );

    expect(receipt.status).toBe('sent');
    const body = JSON.parse(calls.find((c) => c.url.includes('mass/send'))!.init!.body as string);
    expect(body.touser).toEqual(['o_1', 'o_2']);
  });

  it('rejects an oversized or empty openid list', async () => {
    const a = createWeChatAdapter(config);
    const empty = await a.massSendToUsers([], { type: 'text', text: 'x' });
    expect(empty.error?.code).toBe('wechat_no_recipients');

    const tooMany = await a.massSendToUsers(
      Array.from({ length: 10_001 }, (_, i) => `o${i}`),
      { type: 'text', text: 'x' },
    );
    expect(tooMany.error?.code).toBe('wechat_recipient_limit');
  });

  it('requires a media_id for image mass sends', async () => {
    const receipt = await createWeChatAdapter(config).massSend({
      type: 'image',
      mediaRef: { kind: 'url', value: 'https://x/y.png' },
    });
    expect(receipt.error?.code).toBe('wechat_unsupported_content');
    expect(receipt.error?.message).toContain('uploadMedia');
  });
});
