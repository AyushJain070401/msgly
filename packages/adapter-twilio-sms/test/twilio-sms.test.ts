import { describe, expect, it } from 'vitest';

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
