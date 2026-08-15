import { afterEach, describe, expect, it, vi } from 'vitest';

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

// ---------------------------------------------------------------------------
// send() — the outbound path. Previously untested end to end, including the
// template branch every campaign depends on.
// ---------------------------------------------------------------------------

describe('send', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockSend(payload: unknown = { messages: [{ id: 'wamid.ABC' }] }, status = 200) {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: status < 400, status, json: async () => payload } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  function outbound(content: Parameters<ReturnType<typeof createWhatsAppAdapter>['send']>[0]['content']) {
    return {
      id: 'm-1',
      direction: 'outbound' as const,
      channel: 'whatsapp' as const,
      account: { channel: 'whatsapp' as const, channelAccountId: '123456789' },
      contact: { channel: 'whatsapp' as const, channelUserId: '919999999999' },
      content,
      timestamp: new Date().toISOString(),
    };
  }

  const bodyOf = (calls: Array<{ init?: RequestInit }>) =>
    JSON.parse(calls[0]!.init!.body as string);

  it('sends text with the messaging_product envelope', async () => {
    const calls = mockSend();
    const receipt = await createWhatsAppAdapter(config).send(
      outbound({ type: 'text', text: 'hello' }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('wamid.ABC');
    expect(calls[0]!.url).toContain('/123456789/messages');
    expect((calls[0]!.init!.headers as Record<string, string>).authorization).toBe(
      'Bearer wa-token',
    );

    expect(bodyOf(calls)).toEqual({
      messaging_product: 'whatsapp',
      recipient_type: 'individual',
      to: '919999999999',
      type: 'text',
      text: { body: 'hello' },
    });
  });

  it('uses id for an uploaded media ref and link for a URL', async () => {
    let calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({
        type: 'image',
        mediaRef: { kind: 'platform-id', value: 'media-1' },
        caption: 'chart',
      }),
    );
    expect(bodyOf(calls).image).toEqual({ id: 'media-1', caption: 'chart' });

    calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'https://cdn/x.png' } }),
    );
    expect(bodyOf(calls).image).toEqual({ link: 'https://cdn/x.png' });
  });

  it('omits the caption on audio, which WhatsApp does not accept', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({
        type: 'audio',
        mediaRef: { kind: 'platform-id', value: 'a-1' },
        caption: 'ignored',
      }),
    );
    expect(bodyOf(calls).audio).toEqual({ id: 'a-1' });
  });

  it('maps file content onto the document type', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({
        type: 'file',
        mediaRef: { kind: 'platform-id', value: 'doc-1' },
        caption: 'invoice.pdf',
      }),
    );

    const body = bodyOf(calls);
    expect(body.type).toBe('document');
    expect(body.document).toEqual({ id: 'doc-1', caption: 'invoice.pdf' });
  });

  it('sends a location with optional name and address', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({ type: 'location', latitude: 12.9, longitude: 77.6, name: 'HQ' }),
    );

    expect(bodyOf(calls).location).toEqual({ latitude: 12.9, longitude: 77.6, name: 'HQ' });
  });

  it('flattens buttons, caps at 3 and truncates labels to 20 chars', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({
        type: 'interactive',
        text: 'Pick one',
        buttons: [
          [{ id: 'a', label: 'A'.repeat(30) }],
          [{ id: 'b', label: 'B' }, { id: 'c', label: 'C' }],
          [{ id: 'd', label: 'D' }],
        ],
      }),
    );

    const buttons = bodyOf(calls).interactive.action.buttons;
    // WhatsApp rejects more than 3 reply buttons outright.
    expect(buttons).toHaveLength(3);
    expect(buttons[0].reply.title).toHaveLength(20);
    expect(buttons.map((b: { reply: { id: string } }) => b.reply.id)).toEqual(['a', 'b', 'c']);
  });

  it('builds a body component from template variables', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({
        type: 'template',
        templateName: 'order_update',
        language: 'en_US',
        variables: { '1': 'Ayush', '2': 'ORD-42' },
      }),
    );

    const body = bodyOf(calls);
    expect(body.type).toBe('template');
    expect(body.template.name).toBe('order_update');
    expect(body.template.language).toEqual({ code: 'en_US' });
    expect(body.template.components).toEqual([
      {
        type: 'body',
        parameters: [
          { type: 'text', text: 'Ayush' },
          { type: 'text', text: 'ORD-42' },
        ],
      },
    ]);
  });

  it('lets explicit components win over variables', async () => {
    const calls = mockSend();
    const components = [{ type: 'header', parameters: [{ type: 'image', image: { link: 'x' } }] }];

    await createWhatsAppAdapter(config).send(
      outbound({
        type: 'template',
        templateName: 'promo',
        language: 'en',
        variables: { '1': 'ignored' },
        components,
      }),
    );

    // Rich templates need pass-through; the shorthand must not override them.
    expect(bodyOf(calls).template.components).toEqual(components);
  });

  it('omits components entirely for a template with neither', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send(
      outbound({ type: 'template', templateName: 'plain', language: 'en' }),
    );
    expect(bodyOf(calls).template.components).toBeUndefined();
  });

  it('surfaces a Meta error code on the receipt', async () => {
    mockSend({ error: { code: 131047, message: 'Re-engagement message' } }, 400);
    const receipt = await createWhatsAppAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('wa_131047');
    expect(receipt.error?.message).toBe('Re-engagement message');
  });

  it('fails when the API returns 200 with no message id', async () => {
    // A 2xx without `messages` is not a successful send.
    mockSend({}, 200);
    const receipt = await createWhatsAppAdapter(config).send(
      outbound({ type: 'text', text: 'hi' }),
    );
    expect(receipt.status).toBe('failed');
  });
});

describe('fmt', () => {
  it('produces WhatsApp markup, which uses single characters', async () => {
    const { fmt } = await import('../src/index.js');
    // WhatsApp differs from Slack and Markdown here.
    expect(fmt.bold('x')).toBe('*x*');
    expect(fmt.italic('x')).toBe('_x_');
    expect(fmt.strikethrough('x')).toBe('~x~');
    expect(fmt.monospace('x')).toBe('```x```');
  });
});
