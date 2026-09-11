import { describe, expect, it } from 'vitest';

import { createTwilioVoiceAdapter, twiml } from '../src/index.js';

const config = {
  accountSid: 'ACtest_fake_sid_for_unit_tests_only',
  authToken: 'test-auth-token',
  phoneNumber: '+15551234567',
};

const encode = (s: string) => new TextEncoder().encode(s);

describe('createTwilioVoiceAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createTwilioVoiceAdapter(config);
    expect(a.channel).toBe('twilio-voice');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.audio).toBe(true);
    expect(a.capabilities.media.image).toBe(false);
    expect(a.capabilities.templates).toBe(false);
  });

  it('rejects unverifiable webhooks when webhookUrl is unset', async () => {
    // Twilio's signature is the only proof a request came from Twilio, and it
    // covers the full URL — so without webhookUrl there is nothing to check.
    const a = createTwilioVoiceAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: new Uint8Array(),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('accepts unverifiable webhooks only with the explicit opt-in', async () => {
    const a = createTwilioVoiceAdapter({ ...config, allowUnsignedWebhooks: true });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: new Uint8Array(),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects when signature header is missing and webhookUrl is set', async () => {
    const a = createTwilioVoiceAdapter({
      ...config,
      webhookUrl: 'https://example.com/webhook/twilio-voice',
    });
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(false);
  });

  it('parses an incoming call', async () => {
    const a = createTwilioVoiceAdapter(config);
    const body = {
      CallSid: 'CA1234',
      From: '+15559876543',
      To: '+15551234567',
      CallStatus: 'ringing',
      Direction: 'inbound',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('twilio-voice');
    expect(m.externalId).toBe('CA1234');
    expect(m.contact.channelUserId).toBe('+15559876543');
    expect((m.content as { text: string }).text).toBe('[call:ringing]');
    expect(m.metadata?.callStatus).toBe('ringing');
  });

  it('parses DTMF digits from Gather', async () => {
    const a = createTwilioVoiceAdapter(config);
    const body = {
      CallSid: 'CA5678',
      From: '+15559876543',
      To: '+15551234567',
      CallStatus: 'in-progress',
      Digits: '42',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('42');
    expect(m.metadata?.digits).toBe('42');
  });

  it('parses speech input from Gather', async () => {
    const a = createTwilioVoiceAdapter(config);
    const body = {
      CallSid: 'CA9999',
      From: '+15559876543',
      To: '+15551234567',
      CallStatus: 'in-progress',
      SpeechResult: 'I need help with my order',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe(
      'I need help with my order',
    );
  });

  it('parses a recording webhook', async () => {
    const a = createTwilioVoiceAdapter(config);
    const body = {
      CallSid: 'CA1111',
      From: '+15559876543',
      To: '+15551234567',
      CallStatus: 'completed',
      RecordingUrl: 'https://api.twilio.com/recordings/RE123',
      TranscriptionText: 'hello world',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    const c = messages[0]!.content as {
      type: string;
      mediaRef: { value: string };
      caption: string;
    };
    expect(c.type).toBe('audio');
    expect(c.mediaRef.value).toBe(
      'https://api.twilio.com/recordings/RE123',
    );
    expect(c.caption).toBe('hello world');
  });

  it('returns empty array for missing CallSid', async () => {
    const a = createTwilioVoiceAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { From: '+15559876543' },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('verifyCredentials returns hint when accountSid is empty', async () => {
    const a = createTwilioVoiceAdapter({ ...config, accountSid: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('accountSid');
    }
  });
});

describe('twiml helpers', () => {
  it('builds a Say verb', () => {
    expect(twiml.say('Hello')).toBe('<Say>Hello</Say>');
  });

  it('builds a Say with voice and language', () => {
    expect(twiml.say('Hi', { voice: 'alice', language: 'en-US' })).toBe(
      '<Say voice="alice" language="en-US">Hi</Say>',
    );
  });

  it('escapes XML in Say text', () => {
    expect(twiml.say('a < b & c > d')).toBe(
      '<Say>a &lt; b &amp; c &gt; d</Say>',
    );
  });

  it('builds a Gather with inner Say', () => {
    const result = twiml.gather(twiml.say('Press 1'), {
      input: 'dtmf',
      numDigits: 1,
    });
    expect(result).toBe(
      '<Gather input="dtmf" numDigits="1"><Say>Press 1</Say></Gather>',
    );
  });

  it('builds a Play verb', () => {
    expect(twiml.play('https://example.com/audio.mp3')).toBe(
      '<Play>https://example.com/audio.mp3</Play>',
    );
  });

  it('wraps verbs in Response', () => {
    const result = twiml.wrap(twiml.say('Hi'), twiml.hangup());
    expect(result).toBe(
      '<?xml version="1.0" encoding="UTF-8"?><Response><Say>Hi</Say><Hangup/></Response>',
    );
  });

  it('builds Pause, Redirect, Reject, Record', () => {
    expect(twiml.pause(2)).toBe('<Pause length="2"/>');
    expect(twiml.redirect('https://x.com/next')).toBe(
      '<Redirect>https://x.com/next</Redirect>',
    );
    expect(twiml.reject('busy')).toBe('<Reject reason="busy"/>');
    expect(twiml.record({ maxLength: 30 })).toBe(
      '<Record maxLength="30"/>',
    );
  });
});

// ---------------------------------------------------------------------------
// The request/response model. None of this was covered before, which is how a
// shared `pendingTwiml` survived: it made every caller hear the *previous*
// caller's TwiML, and returned invalid TwiML on the very first call.
// ---------------------------------------------------------------------------

const callReq = (over: Record<string, string> = {}) => ({
  headers: {},
  rawBody: new Uint8Array(),
  body: { CallSid: 'CA1', From: '+15550001', To: '+15551234567', CallStatus: 'ringing', ...over },
  query: {},
});

describe('getInteractionAck (per-request TwiML)', () => {
  it('answers each request from that request, not from shared state', () => {
    const seen: string[] = [];
    const a = createTwilioVoiceAdapter({
      ...config,
      respond: (msg) => {
        seen.push(msg.contact.channelUserId);
        return twiml.say(`Hello ${msg.contact.channelUserId}`);
      },
    });

    const first = a.getInteractionAck!(callReq({ CallSid: 'CA1', From: '+15550001' }));
    const second = a.getInteractionAck!(callReq({ CallSid: 'CA2', From: '+15550002' }));

    // Each caller must hear their own greeting — no cross-talk, no off-by-one.
    expect(first).not.toBeNull();
    expect((first as { body: string }).body).toContain('+15550001');
    expect((second as { body: string }).body).toContain('+15550002');
    expect(seen).toEqual(['+15550001', '+15550002']);
  });

  it('wraps bare verbs into a TwiML document', () => {
    const a = createTwilioVoiceAdapter({ ...config, respond: () => twiml.say('hi') });
    const ack = a.getInteractionAck!(callReq()) as { body: string; contentType?: string };
    expect(ack.body).toBe('<?xml version="1.0" encoding="UTF-8"?><Response><Say>hi</Say></Response>');
    expect(ack.contentType).toBe('application/xml');
  });

  it('passes a full document through untouched', () => {
    const doc = twiml.wrap(twiml.hangup());
    const a = createTwilioVoiceAdapter({ ...config, respond: () => doc });
    expect((a.getInteractionAck!(callReq()) as { body: string }).body).toBe(doc);
  });

  it('returns null when no responder is configured', () => {
    expect(createTwilioVoiceAdapter(config).getInteractionAck!(callReq())).toBeNull();
  });

  it('returns null when the responder declines', () => {
    const a = createTwilioVoiceAdapter({ ...config, respond: () => null });
    expect(a.getInteractionAck!(callReq())).toBeNull();
  });

  it('returns null for a payload that is not a call', () => {
    const a = createTwilioVoiceAdapter({ ...config, respond: () => twiml.hangup() });
    expect(a.getInteractionAck!({ ...callReq(), body: { foo: 'bar' } })).toBeNull();
  });
});

describe('send (drives a live call over the REST API)', () => {
  const originalFetch = globalThis.fetch;

  function mockFetch(payload: unknown = { sid: 'CA1', status: 'in-progress' }, status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  const outbound = (content: unknown, metadata?: Record<string, unknown>) =>
    ({
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'twilio-voice' as const,
      account: { channel: 'twilio-voice' as const, channelAccountId: '+15551234567' },
      contact: { channel: 'twilio-voice' as const, channelUserId: '+15550001' },
      content,
      timestamp: new Date().toISOString(),
      ...(metadata ? { metadata } : {}),
    }) as Parameters<ReturnType<typeof createTwilioVoiceAdapter>['send']>[0];

  it('updates the live call with TwiML built from text', async () => {
    const calls = mockFetch();
    try {
      const r = await createTwilioVoiceAdapter(config).send(
        outbound({ type: 'text', text: 'Your order shipped' }, { callSid: 'CA1' }),
      );
      expect(r.status).toBe('sent');
      expect(calls[0]!.url).toContain('/Calls/CA1.json');
      const body = new URLSearchParams(calls[0]!.init!.body as string);
      expect(body.get('Twiml')).toContain('<Say');
      expect(body.get('Twiml')).toContain('Your order shipped');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('accepts audio content and emits <Play> — the capability is no longer a lie', async () => {
    const calls = mockFetch();
    try {
      const r = await createTwilioVoiceAdapter(config).send(
        outbound(
          { type: 'audio', mediaRef: { kind: 'url', value: 'https://cdn/x.mp3' } },
          { callSid: 'CA1' },
        ),
      );
      expect(r.status).toBe('sent');
      const body = new URLSearchParams(calls[0]!.init!.body as string);
      expect(body.get('Twiml')).toContain('<Play>https://cdn/x.mp3</Play>');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects audio that Twilio could not fetch', async () => {
    const r = await createTwilioVoiceAdapter(config).send(
      outbound(
        { type: 'audio', mediaRef: { kind: 'platform-id', value: 'abc' } },
        { callSid: 'CA1' },
      ),
    );
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('twilio_voice_unplayable_media');
  });

  it('explains itself when the CallSid is missing', async () => {
    const r = await createTwilioVoiceAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('twilio_voice_missing_call_sid');
    expect(r.error?.message).toContain('config.respond');
  });

  it('still rejects content a phone call cannot carry', async () => {
    const r = await createTwilioVoiceAdapter(config).send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'https://cdn/x.png' } }, { callSid: 'CA1' }),
    );
    expect(r.status).toBe('failed');
    expect(r.error?.code).toBe('twilio_voice_unsupported_content');
  });

  it('surfaces a Twilio API failure as a failed receipt', async () => {
    mockFetch({ error_message: 'Call is not in-progress' }, 400);
    try {
      const r = await createTwilioVoiceAdapter(config).send(
        outbound({ type: 'text', text: 'hi' }, { callSid: 'CA1' }),
      );
      expect(r.status).toBe('failed');
      expect(r.error?.message).toContain('Call is not in-progress');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

describe('parseStatuses', () => {
  const a = createTwilioVoiceAdapter(config);

  it('maps call progress onto delivery statuses', () => {
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'ringing' })[0]).toMatchObject({ status: 'sent' });
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'in-progress' })[0]).toMatchObject({ status: 'delivered' });
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'completed' })[0]).toMatchObject({ status: 'read' });
  });

  it('marks only a failed call permanent — busy and no-answer may work later', () => {
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'busy' })[0]!.error).toMatchObject({ permanent: false });
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'no-answer' })[0]!.error).toMatchObject({ permanent: false });
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'failed' })[0]!.error).toMatchObject({ permanent: true });
  });

  it('carries the callee and Twilio error code', () => {
    const [r] = a.parseStatuses({ CallSid: 'CA1', CallStatus: 'failed', To: '+15550001', ErrorCode: '13224' });
    expect(r).toMatchObject({ recipientId: '+15550001', error: { code: '13224' } });
  });

  it('ignores payloads that are not status callbacks', () => {
    expect(a.parseStatuses({ foo: 'bar' })).toEqual([]);
    expect(a.parseStatuses({ CallSid: 'CA1', CallStatus: 'nonsense' })).toEqual([]);
    expect(a.parseStatuses(undefined)).toEqual([]);
  });
});

describe('call control', () => {
  const originalFetch = globalThis.fetch;

  it('ends a call by setting its status to completed', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ sid: 'CA1', status: 'completed' }) } as Response;
    }) as unknown as typeof fetch;
    try {
      await createTwilioVoiceAdapter(config).endCall('CA1');
      expect(calls[0]!.url).toContain('/Calls/CA1.json');
      expect(new URLSearchParams(calls[0]!.init!.body as string).get('Status')).toBe('completed');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('requires twiml or url when updating a call', async () => {
    await expect(createTwilioVoiceAdapter(config).updateCall('CA1', {})).rejects.toThrow(
      'requires either twiml or url',
    );
  });
});

describe('downloadMedia (recordings sit behind account auth)', () => {
  const originalFetch = globalThis.fetch;

  it('appends the extension Twilio requires and authenticates', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        headers: new Headers({ 'content-type': 'audio/wav' }),
        arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      } as unknown as Response;
    }) as unknown as typeof fetch;
    try {
      const file = await createTwilioVoiceAdapter(config).downloadMedia({
        kind: 'url',
        value: 'https://api.twilio.com/.../Recordings/RE1',
      });
      expect(calls[0]!.url).toMatch(/\.wav$/);
      expect((calls[0]!.init!.headers as Record<string, string>).authorization).toMatch(/^Basic /);
      expect(file.mimeType).toBe('audio/wav');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('rejects a non-url ref', async () => {
    await expect(
      createTwilioVoiceAdapter(config).downloadMedia({ kind: 'platform-id', value: 'x' }),
    ).rejects.toThrow('url mediaRef');
  });
});

describe('interactive → <Gather> (documented but previously unimplemented)', () => {
  const originalFetch = globalThis.fetch;

  it('declares button support now that Gather is wired', () => {
    expect(createTwilioVoiceAdapter(config).capabilities.interactive.buttons).toBe(true);
  });

  it('emits a Gather wrapping the prompt', async () => {
    const calls: Array<{ init?: RequestInit }> = [];
    globalThis.fetch = (async (_u: string, init?: RequestInit) => {
      calls.push({ init });
      return { ok: true, status: 200, json: async () => ({ sid: 'CA1', status: 'in-progress' }) } as Response;
    }) as unknown as typeof fetch;
    try {
      const r = await createTwilioVoiceAdapter(config).send({
        id: 'm-1',
        direction: 'outbound',
        channel: 'twilio-voice',
        account: { channel: 'twilio-voice', channelAccountId: '+15551234567' },
        contact: { channel: 'twilio-voice', channelUserId: '+15550001' },
        content: {
          type: 'interactive',
          text: 'Press 1 to confirm, 2 to reschedule.',
          buttons: [
            { id: 'confirm', label: 'Confirm' },
            { id: 'reschedule', label: 'Reschedule' },
          ],
        },
        timestamp: new Date().toISOString(),
        metadata: { callSid: 'CA1' },
      });
      expect(r.status).toBe('sent');
      const twimlBody = new URLSearchParams(calls[0]!.init!.body as string).get('Twiml')!;
      expect(twimlBody).toContain('<Gather');
      expect(twimlBody).toContain('input="dtmf"');
      expect(twimlBody).toContain('Press 1 to confirm');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('works through the respond path too, where an IVR actually lives', () => {
    const a = createTwilioVoiceAdapter({
      ...config,
      respond: () =>
        twiml.gather(twiml.say('Press 1 for sales.'), { input: 'dtmf', numDigits: 1 }),
    });
    const ack = a.getInteractionAck!(callReq()) as { body: string };
    expect(ack.body).toContain('<Gather input="dtmf" numDigits="1">');
  });
});
