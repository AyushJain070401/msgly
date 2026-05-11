import { describe, expect, it } from 'vitest';

import { createWhatsAppAdapter } from '../src/index.js';

const config = {
  phoneNumberId: '123456789',
  accessToken: 'wa-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
};

const encode = (s: string) => new TextEncoder().encode(s);

async function signWhatsApp(body: Uint8Array): Promise<string> {
  const key = await globalThis.crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(config.appSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const buffer = body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength);
  const sig = new Uint8Array(await globalThis.crypto.subtle.sign('HMAC', key, buffer));
  let hex = '';
  for (let i = 0; i < sig.length; i++) hex += sig[i]!.toString(16).padStart(2, '0');
  return `sha256=${hex}`;
}

describe('createWhatsAppAdapter', () => {
  it('declares template capability', () => {
    const a = createWhatsAppAdapter(config);
    expect(a.channel).toBe('whatsapp');
    expect(a.capabilities.templates).toBe(true);
  });

  it('verifies webhook signature', async () => {
    const a = createWhatsAppAdapter(config);
    const body = encode('{"object":"whatsapp_business_account"}');
    const sig = await signWhatsApp(body);
    expect(
      await a.verifySignature({
        headers: { 'x-hub-signature-256': sig },
        rawBody: body,
        body: {},
        query: {},
      }),
    ).toBe(true);
  });

  it('parses an inbound text message with profile name', async () => {
    const a = createWhatsAppAdapter(config);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz-id',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456789' },
                contacts: [{ profile: { name: 'Udesh' }, wa_id: '919999999999' }],
                messages: [
                  {
                    id: 'wamid.abc',
                    from: '919999999999',
                    timestamp: '1700000000',
                    type: 'text',
                    text: { body: 'hello from whatsapp' },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('whatsapp');
    expect(m.contact.displayName).toBe('Udesh');
    expect(m.contact.channelUserId).toBe('919999999999');
    expect((m.content as { text: string }).text).toBe('hello from whatsapp');
  });

  it('parses an inbound image with platform-id reference', async () => {
    const a = createWhatsAppAdapter(config);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz-id',
          changes: [
            {
              field: 'messages',
              value: {
                messages: [
                  {
                    id: 'wamid.img',
                    from: '919999999999',
                    timestamp: '1700000000',
                    type: 'image',
                    image: {
                      id: 'media-abc',
                      mime_type: 'image/jpeg',
                      caption: 'a photo',
                    },
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    const c = messages[0]!.content as {
      type: string;
      mediaRef: { kind: string; value: string };
      caption?: string;
    };
    expect(c.type).toBe('image');
    expect(c.mediaRef.kind).toBe('platform-id');
    expect(c.mediaRef.value).toBe('media-abc');
    expect(c.caption).toBe('a photo');
  });

  it('skips status webhooks during message parsing', async () => {
    const a = createWhatsAppAdapter(config);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz-id',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  {
                    id: 'wamid.delivered',
                    status: 'delivered',
                    timestamp: '1700000000',
                  },
                ],
              },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('parses status updates into delivery receipts', () => {
    const a = createWhatsAppAdapter(config);
    const receipts = a.parseStatuses({
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'biz',
          changes: [
            {
              field: 'messages',
              value: {
                statuses: [
                  { id: 'wamid.1', status: 'delivered', timestamp: '1700000000' },
                  { id: 'wamid.2', status: 'read', timestamp: '1700000001' },
                  {
                    id: 'wamid.3',
                    status: 'failed',
                    timestamp: '1700000002',
                    errors: [{ code: 131026, title: 'Receiver incapable' }],
                  },
                ],
              },
            },
          ],
        },
      ],
    });
    expect(receipts).toHaveLength(3);
    expect(receipts[0]!.status).toBe('delivered');
    expect(receipts[1]!.status).toBe('read');
    expect(receipts[2]!.status).toBe('failed');
    expect(receipts[2]!.error?.message).toBe('Receiver incapable');
  });

  it('handles webhook GET challenge', () => {
    const a = createWhatsAppAdapter(config);
    expect(
      a.verifyWebhookChallenge!({
        'hub.mode': 'subscribe',
        'hub.verify_token': 'verify-token',
        'hub.challenge': 'abc',
      }),
    ).toBe('abc');
  });

  it('verifyCredentials hint says where to find the phone number ID', async () => {
    const a = createWhatsAppAdapter({
      phoneNumberId: '',
      accessToken: 'x',
      appSecret: 'y',
      verifyToken: 'z',
    });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.hint).toContain('Phone number ID');
      expect(result.hint).toContain('API Setup');
    }
  });

  it('verifyCredentials hint mentions 24h temporary token expiry', async () => {
    const a = createWhatsAppAdapter({
      phoneNumberId: '123',
      accessToken: '',
      appSecret: 'y',
      verifyToken: 'z',
    });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('24h');
  });
});
