import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSlackAdapter } from '../src/index.js';

const config = {
  botToken: 'xoxb-test',
  signingSecret: 'shh',
};

const encode = (s: string) => new TextEncoder().encode(s);

function mockFetchJson(response: Record<string, unknown> = { ok: true }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 200,
    statusText: 'OK',
    json: async () => response,
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createSlackAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createSlackAdapter(config);
    expect(a.channel).toBe('slack');
    expect(a.capabilities.interactive.buttons).toBe(true);
  });

  describe('button click interactions', () => {
    it('carries response_url and thread_ts in metadata', async () => {
      const a = createSlackAdapter(config);
      const payload = {
        type: 'block_actions',
        team: { id: 'T1' },
        channel: { id: 'C1' },
        user: { id: 'U1' },
        message: { ts: '111.222', thread_ts: '100.000' },
        response_url: 'https://hooks.slack.com/actions/T1/1/abc',
        actions: [{ action_id: 'track', value: 'track' }],
      };
      const req = {
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        rawBody: encode(`payload=${encodeURIComponent(JSON.stringify(payload))}`),
        body: {},
        query: {},
      };
      const [msg] = await a.handleWebhook(req);
      expect(msg?.metadata?.['responseUrl']).toBe('https://hooks.slack.com/actions/T1/1/abc');
      expect(msg?.metadata?.['threadTs']).toBe('100.000');
      expect(msg?.interaction?.data).toBe('track');
    });
  });

  describe('message events', () => {
    it('carries thread_ts in metadata when replying inside a thread', async () => {
      const a = createSlackAdapter(config);
      const body = {
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'message',
          text: 'hello',
          user: 'U1',
          channel: 'C1',
          ts: '222.333',
          thread_ts: '100.000',
        },
      };
      const [msg] = await a.handleWebhook({
        headers: {},
        rawBody: encode(''),
        body,
        query: {},
      });
      expect(msg?.metadata?.['threadTs']).toBe('100.000');
    });

    it('omits metadata for top-level (non-threaded) messages', async () => {
      const a = createSlackAdapter(config);
      const body = {
        type: 'event_callback',
        team_id: 'T1',
        event: { type: 'message', text: 'hi', user: 'U1', channel: 'C1', ts: '222.333' },
      };
      const [msg] = await a.handleWebhook({
        headers: {},
        rawBody: encode(''),
        body,
        query: {},
      });
      expect(msg?.metadata).toBeUndefined();
    });
  });

  describe('assistant thread events', () => {
    it('parses assistant_thread_started into an inbound message', async () => {
      const a = createSlackAdapter(config);
      const body = {
        type: 'event_callback',
        team_id: 'T1',
        event: {
          type: 'assistant_thread_started',
          assistant_thread: { channel_id: 'C1', thread_ts: '100.000', context: { foo: 'bar' } },
        },
      };
      const [msg] = await a.handleWebhook({
        headers: {},
        rawBody: encode(''),
        body,
        query: {},
      });
      expect(msg?.metadata?.['slackEvent']).toBe('assistant_thread_started');
      expect(msg?.metadata?.['threadTs']).toBe('100.000');
      expect(msg?.contact.channelUserId).toBe('C1');
    });
  });

  describe('send with thread replies', () => {
    it('includes thread_ts when message.metadata.threadTs is set', async () => {
      const fetchMock = mockFetchJson({ ok: true, ts: '999.999' });
      const a = createSlackAdapter(config);
      await a.send({
        id: 'm1',
        channel: 'slack',
        direction: 'outbound',
        account: { channel: 'slack', channelAccountId: 'T1' },
        contact: { channel: 'slack', channelUserId: 'C1' },
        content: { type: 'text', text: 'reply' },
        timestamp: new Date().toISOString(),
        metadata: { threadTs: '100.000' },
      });
      const [, init] = fetchMock.mock.calls[0]!;
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.thread_ts).toBe('100.000');
    });
  });

  describe('updateMessage / deleteMessage', () => {
    it('calls chat.update with channel, ts, text', async () => {
      const fetchMock = mockFetchJson({ ok: true, ts: '111.222' });
      const a = createSlackAdapter(config);
      const result = await a.updateMessage({ channel: 'C1', ts: '111.222', text: 'You asked: hi' });
      expect(result.ts).toBe('111.222');
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://slack.com/api/chat.update');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toMatchObject({ channel: 'C1', ts: '111.222', text: 'You asked: hi' });
    });

    it('calls chat.delete with channel and ts', async () => {
      const fetchMock = mockFetchJson({ ok: true });
      const a = createSlackAdapter(config);
      await a.deleteMessage({ channel: 'C1', ts: '111.222' });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://slack.com/api/chat.delete');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ channel: 'C1', ts: '111.222' });
    });
  });

  describe('respondToInteraction', () => {
    it('POSTs to the response_url without an auth header, replacing the original', async () => {
      const fetchMock = vi.fn().mockResolvedValue({ ok: true, status: 200, statusText: 'OK' });
      vi.stubGlobal('fetch', fetchMock);
      const a = createSlackAdapter(config);
      await a.respondToInteraction('https://hooks.slack.com/actions/T1/1/abc', {
        text: 'You asked: What is Katonic AI?',
        replaceOriginal: true,
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://hooks.slack.com/actions/T1/1/abc');
      expect((init as RequestInit).headers).not.toHaveProperty('authorization');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toMatchObject({ text: 'You asked: What is Katonic AI?', replace_original: true });
    });

    it('throws when the response_url POST fails', async () => {
      vi.stubGlobal(
        'fetch',
        vi.fn().mockResolvedValue({ ok: false, status: 404, statusText: 'Not Found' }),
      );
      const a = createSlackAdapter(config);
      await expect(
        a.respondToInteraction('https://hooks.slack.com/actions/expired', { text: 'x' }),
      ).rejects.toThrow(/404/);
    });
  });

  describe('assistant status helpers', () => {
    it('setAssistantStatus calls assistant.threads.setStatus', async () => {
      const fetchMock = mockFetchJson();
      const a = createSlackAdapter(config);
      await a.setAssistantStatus({ channelId: 'C1', threadTs: '100.000', status: 'is thinking...' });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://slack.com/api/assistant.threads.setStatus');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body).toEqual({ channel_id: 'C1', thread_ts: '100.000', status: 'is thinking...' });
    });

    it('setAssistantSuggestedPrompts calls assistant.threads.setSuggestedPrompts', async () => {
      const fetchMock = mockFetchJson();
      const a = createSlackAdapter(config);
      await a.setAssistantSuggestedPrompts({
        channelId: 'C1',
        threadTs: '100.000',
        prompts: [{ title: 'Ask about pricing', message: 'What does Katonic AI cost?' }],
      });
      const [url, init] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://slack.com/api/assistant.threads.setSuggestedPrompts');
      const body = JSON.parse((init as RequestInit).body as string);
      expect(body.prompts).toHaveLength(1);
    });

    it('setAssistantTitle calls assistant.threads.setTitle', async () => {
      const fetchMock = mockFetchJson();
      const a = createSlackAdapter(config);
      await a.setAssistantTitle({ channelId: 'C1', threadTs: '100.000', title: 'Katonic AI Q&A' });
      const [url] = fetchMock.mock.calls[0]!;
      expect(url).toBe('https://slack.com/api/assistant.threads.setTitle');
    });
  });

  describe('verifySignature', () => {
    it('rejects missing signature headers', async () => {
      const a = createSlackAdapter(config);
      expect(
        await a.verifySignature({ headers: {}, rawBody: encode(''), body: {}, query: {} }),
      ).toBe(false);
    });
  });
});
