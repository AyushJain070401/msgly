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

  it('skips signature check when webhookUrl is unset', async () => {
    const a = createTwilioVoiceAdapter(config);
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
