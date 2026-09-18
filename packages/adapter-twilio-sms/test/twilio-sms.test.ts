import { afterEach, describe, expect, it, vi } from 'vitest';

import { createTwilioSmsAdapter } from '../src/index.js';

const config = {
  accountSid: 'ACtest_fake_sid_for_unit_tests_only',
  authToken: 'test-auth-token',
  phoneNumber: '+15551234567',
};

const encode = (s: string) => new TextEncoder().encode(s);

describe('createTwilioSmsAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createTwilioSmsAdapter(config);
    expect(a.channel).toBe('twilio-sms');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.image).toBe(true);
    expect(a.capabilities.media.video).toBe(false);
    expect(a.capabilities.templates).toBe(false);
  });

  it('skips signature check when webhookUrl is unset', async () => {
    const a = createTwilioSmsAdapter(config);
    expect(
      await a.verifySignature({
        headers: {},
        rawBody: encode(''),
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('rejects when signature header is missing and webhookUrl is set', async () => {
    const a = createTwilioSmsAdapter({
      ...config,
      webhookUrl: 'https://example.com/webhook/twilio-sms',
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

  it('parses an inbound text SMS', async () => {
    const a = createTwilioSmsAdapter(config);
    const body = {
      MessageSid: 'SM1234',
      From: '+15559876543',
      To: '+15551234567',
      Body: 'Hello from SMS!',
      NumMedia: '0',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('twilio-sms');
    expect(m.externalId).toBe('SM1234');
    expect(m.contact.channelUserId).toBe('+15559876543');
    expect((m.content as { text: string }).text).toBe('Hello from SMS!');
  });

  it('parses an inbound MMS with image', async () => {
    const a = createTwilioSmsAdapter(config);
    const body = {
      MessageSid: 'MM5678',
      From: '+15559876543',
      To: '+15551234567',
      Body: 'Check this out',
      NumMedia: '1',
      MediaUrl0: 'https://api.twilio.com/media/image.jpg',
      MediaContentType0: 'image/jpeg',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const c = messages[0]!.content as {
      type: string;
      mediaRef: { value: string; mimeType: string };
      caption: string;
    };
    expect(c.type).toBe('image');
    expect(c.mediaRef.value).toBe('https://api.twilio.com/media/image.jpg');
    expect(c.caption).toBe('Check this out');
  });

  it('returns empty array for missing From', async () => {
    const a = createTwilioSmsAdapter(config);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { MessageSid: 'SM1', Body: 'orphan' },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('includes geo metadata when present', async () => {
    const a = createTwilioSmsAdapter(config);
    const body = {
      MessageSid: 'SM9',
      From: '+15559876543',
      To: '+15551234567',
      Body: 'geo',
      NumMedia: '0',
      FromCity: 'San Francisco',
      FromState: 'CA',
      FromCountry: 'US',
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages[0]!.metadata).toMatchObject({
      fromCity: 'San Francisco',
      fromState: 'CA',
      fromCountry: 'US',
    });
  });

  it('verifyCredentials returns hint when accountSid is empty', async () => {
    const a = createTwilioSmsAdapter({ ...config, accountSid: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('accountSid');
    }
  });

  it('verifyCredentials returns hint when accountSid lacks AC prefix', async () => {
    const a = createTwilioSmsAdapter({ ...config, accountSid: 'NOTVALID' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
  });

  it('verifyCredentials returns hint when phoneNumber is missing', async () => {
    const a = createTwilioSmsAdapter({ ...config, phoneNumber: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toContain('phoneNumber');
    }
  });
});

describe('verifyPhoneNumber', () => {
  const creds = {
    accountSid: 'AC123',
    authToken: 'tok',
    phoneNumber: '+15551234567',
  };

  function mockTwilio(handler: (url: string) => Response) {
    globalThis.fetch = (async (url: string) => handler(String(url))) as unknown as typeof fetch;
  }

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('rejects a malformed number without calling the API', async () => {
    const calls: string[] = [];
    mockTwilio((url) => {
      calls.push(url);
      return new Response('{}', { status: 200 });
    });

    const a = createTwilioSmsAdapter({ ...creds, phoneNumber: '555-1234' });
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: false, status: 'malformed' });
    expect(res.hint).toContain('+');
    expect(calls).toHaveLength(0);
  });

  it('confirms a number the account owns', async () => {
    mockTwilio((url) => {
      if (url.includes('IncomingPhoneNumbers.json')) {
        return new Response(
          JSON.stringify({ incoming_phone_numbers: [{ phone_number: '+15551234567' }] }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    });

    const a = createTwilioSmsAdapter(creds);
    expect(await a.verifyPhoneNumber()).toEqual({
      ok: true,
      status: 'owned',
      phoneNumber: '+15551234567',
    });
  });

  it('rejects a well-formed number that belongs to another account', async () => {
    mockTwilio((url) => {
      if (url.includes('IncomingPhoneNumbers.json')) {
        return new Response(JSON.stringify({ incoming_phone_numbers: [] }), { status: 200 });
      }
      return new Response('{}', { status: 200 });
    });

    const a = createTwilioSmsAdapter(creds);
    const res = await a.verifyPhoneNumber();

    expect(res).toMatchObject({ ok: false, status: 'not_owned' });
    expect(res.hint).toContain('+15551234567');
  });

  it('stays ok when the lookup cannot answer, rather than failing a good number', async () => {
    mockTwilio((url) => {
      if (url.includes('IncomingPhoneNumbers.json')) {
        return new Response('{}', { status: 403 });
      }
      return new Response('{}', { status: 200 });
    });

    const a = createTwilioSmsAdapter(creds);
    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: true, status: 'inconclusive' });
  });

  it('fails verifyCredentials when the number is not on the account', async () => {
    mockTwilio((url) => {
      if (url.includes('IncomingPhoneNumbers.json')) {
        return new Response(JSON.stringify({ incoming_phone_numbers: [] }), { status: 200 });
      }
      return new Response(JSON.stringify({ friendly_name: 'Acme' }), { status: 200 });
    });

    const a = createTwilioSmsAdapter(creds);
    const res = await a.verifyCredentials();

    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.hint).toContain('+15551234567');
  });

  it('passes verifyCredentials when both the account and the number check out', async () => {
    mockTwilio((url) => {
      if (url.includes('IncomingPhoneNumbers.json')) {
        return new Response(
          JSON.stringify({ incoming_phone_numbers: [{ phone_number: '+15551234567' }] }),
          { status: 200 },
        );
      }
      return new Response(JSON.stringify({ friendly_name: 'Acme' }), { status: 200 });
    });

    const a = createTwilioSmsAdapter(creds);
    expect(await a.verifyCredentials()).toEqual({
      ok: true,
      accountInfo: 'Acme (+15551234567)',
    });
  });
});

describe('number lookup partial matching', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('finds the exact number even when the filter returns other partial matches', async () => {
    let lookupUrl = '';
    globalThis.fetch = (async (url: string) => {
      const u = String(url);
      if (u.includes('IncomingPhoneNumbers.json')) {
        lookupUrl = u;
        // Twilio's PhoneNumber filter is a partial match, so the page can hold
        // neighbours of the number asked for.
        return new Response(
          JSON.stringify({
            incoming_phone_numbers: [
              { phone_number: '+155512345670' },
              { phone_number: '+15551234567' },
              { phone_number: '+155512345671' },
            ],
          }),
          { status: 200 },
        );
      }
      return new Response('{}', { status: 200 });
    }) as unknown as typeof fetch;

    const a = createTwilioSmsAdapter({
      accountSid: 'AC123',
      authToken: 'tok',
      phoneNumber: '+15551234567',
    });

    expect(await a.verifyPhoneNumber()).toMatchObject({ ok: true, status: 'owned' });
    // A one-row page could have held only a neighbour, reading as not_owned.
    expect(lookupUrl).toContain('PageSize=50');
  });
});
