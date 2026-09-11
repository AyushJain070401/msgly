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

// ---------------------------------------------------------------------------
// Coverage for the 2026 API-parity work: pinned Graph version, reply threading,
// reactions, and the list / CTA-URL interactive types.
// ---------------------------------------------------------------------------

describe('graph API version', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function capture() {
    const calls: string[] = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string) => {
      calls.push(url);
      return { ok: true, status: 200, json: async () => ({ messages: [{ id: 'x' }] }) } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  const msg = {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'whatsapp' as const,
    account: { channel: 'whatsapp' as const, channelAccountId: '123456789' },
    contact: { channel: 'whatsapp' as const, channelUserId: '919999999999' },
    content: { type: 'text' as const, text: 'hi' },
    timestamp: new Date().toISOString(),
  };

  it('defaults to a Graph version that is not past end-of-life', async () => {
    const calls = capture();
    await createWhatsAppAdapter(config).send(msg);
    // v20.0 expired 2026-09-24; anything older than v23.0 is out of support.
    const version = Number(/\/v(\d+)\.0\//.exec(calls[0]!)![1]);
    expect(version).toBeGreaterThanOrEqual(23);
  });

  it('still honours an explicit apiVersion override', async () => {
    const calls = capture();
    await createWhatsAppAdapter({ ...config, apiVersion: 'v21.0' }).send(msg);
    expect(calls[0]).toContain('/v21.0/');
  });
});

describe('replyTo, reactions and rich interactive types', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  function mockSend() {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return {
        ok: true,
        status: 200,
        json: async () => ({ messages: [{ id: 'wamid.ABC' }] }),
      } as Response;
    }) as unknown as typeof fetch;
    return calls;
  }

  const bodyOf = (calls: Array<{ init?: RequestInit }>) =>
    JSON.parse(calls[0]!.init!.body as string);

  const base = {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'whatsapp' as const,
    account: { channel: 'whatsapp' as const, channelAccountId: '123456789' },
    contact: { channel: 'whatsapp' as const, channelUserId: '919999999999' },
    timestamp: new Date().toISOString(),
  };

  it('maps replyTo to a context object', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send({
      ...base,
      content: { type: 'text', text: 'hi' },
      replyTo: 'wamid.PARENT',
    });
    expect(bodyOf(calls).context).toEqual({ message_id: 'wamid.PARENT' });
  });

  it('omits context entirely when replyTo is unset', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send({
      ...base,
      content: { type: 'text', text: 'hi' },
    });
    expect(bodyOf(calls)).not.toHaveProperty('context');
  });

  it('sends a reaction', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).sendReaction(base.contact, 'wamid.ABC', '👍');
    expect(bodyOf(calls)).toMatchObject({
      type: 'reaction',
      reaction: { message_id: 'wamid.ABC', emoji: '👍' },
    });
  });

  it('removes a reaction with an empty emoji', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).sendReaction(base.contact, 'wamid.ABC', '');
    expect(bodyOf(calls).reaction).toEqual({ message_id: 'wamid.ABC', emoji: '' });
  });

  it('declares typing support now that sendTypingIndicator exists', () => {
    const a = createWhatsAppAdapter(config);
    expect(a.capabilities.typing).toBe(true);
    expect(typeof a.sendTypingIndicator).toBe('function');
  });

  it('builds an interactive list and truncates over-long labels', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send({
      ...base,
      content: {
        type: 'list',
        text: 'Pick a slot',
        buttonLabel: 'This label is definitely too long',
        header: 'Booking',
        footer: 'Tap to choose',
        sections: [
          {
            title: 'Morning',
            rows: [{ id: 'r1', title: '09:00', description: 'with Dr. Rao' }],
          },
        ],
      },
    });

    const interactive = bodyOf(calls).interactive;
    expect(interactive.type).toBe('list');
    expect(interactive.header).toEqual({ type: 'text', text: 'Booking' });
    expect(interactive.footer).toEqual({ text: 'Tap to choose' });
    // WhatsApp rejects list button labels over 20 characters.
    expect(interactive.action.button).toHaveLength(20);
    expect(interactive.action.sections[0].rows[0]).toEqual({
      id: 'r1',
      title: '09:00',
      description: 'with Dr. Rao',
    });
  });

  it('builds a cta_url message', async () => {
    const calls = mockSend();
    await createWhatsAppAdapter(config).send({
      ...base,
      content: {
        type: 'cta_url',
        text: 'Your receipt is ready',
        buttonLabel: 'View receipt',
        url: 'https://example.com/r/1',
      },
    });

    expect(bodyOf(calls).interactive).toMatchObject({
      type: 'cta_url',
      body: { text: 'Your receipt is ready' },
      action: {
        name: 'cta_url',
        parameters: { display_text: 'View receipt', url: 'https://example.com/r/1' },
      },
    });
  });

  it('advertises the list and cta_url capabilities', () => {
    const caps = createWhatsAppAdapter(config).capabilities;
    expect(caps.interactive.lists).toBe(true);
    expect(caps.interactive.ctaUrl).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Coexistence — the Business app and the Cloud API on one number. Payload
// shapes follow Meta's documented history / smb_app_state_sync /
// smb_message_echoes webhooks.
// ---------------------------------------------------------------------------

describe('coexistence', () => {
  const originalFetch = globalThis.fetch;
  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  const echoBody = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'smb_message_echoes',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+1 555-0100', phone_number_id: '123456789' },
              message_echoes: [
                {
                  from: '15550100',
                  to: '919999999999',
                  id: 'wamid.ECHO',
                  timestamp: '1750000000',
                  type: 'text',
                  text: { body: 'sent from my phone' },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const historyBody = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'history',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '+1 555-0100', phone_number_id: '123456789' },
              history: [
                {
                  metadata: { phase: 'BACKFILL', chunk_order: 1, progress: 40 },
                  threads: [
                    {
                      id: '919999999999',
                      messages: [
                        {
                          from: '919999999999',
                          to: '15550100',
                          id: 'wamid.IN',
                          timestamp: '1749000000',
                          type: 'text',
                          text: { body: 'hi there' },
                          history_context: { status: 'DELIVERED' },
                        },
                        {
                          from: '+1 555-0100',
                          to: '919999999999',
                          id: 'wamid.OUT',
                          timestamp: '1749000100',
                          type: 'text',
                          text: { body: 'how can I help?' },
                        },
                      ],
                    },
                  ],
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const contactsBody = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'waba-1',
        changes: [
          {
            field: 'smb_app_state_sync',
            value: {
              messaging_product: 'whatsapp',
              metadata: { phone_number_id: '123456789' },
              state_sync: [
                {
                  type: 'contact',
                  contact: { full_name: 'Asha Rao', first_name: 'Asha', phone_number: '919999999999' },
                  action: 'add',
                  metadata: { timestamp: '1750000000' },
                },
                // A non-contact kind must be skipped rather than crashing.
                { type: 'something_new', metadata: { timestamp: '1750000001' } },
              ],
            },
          },
        ],
      },
    ],
  };

  const asRequest = (body: unknown) => ({
    headers: {},
    rawBody: encode(JSON.stringify(body)),
    body,
    query: {},
  });

  it('does not treat echoes as inbound customer messages', async () => {
    const a = createWhatsAppAdapter(config);
    // The critical safety property: a bot must never answer its own operator.
    expect(await a.handleWebhook(asRequest(echoBody))).toEqual([]);
  });

  it('does not replay back-filled history as new inbound messages', async () => {
    const a = createWhatsAppAdapter(config);
    expect(await a.handleWebhook(asRequest(historyBody))).toEqual([]);
  });

  it('still parses ordinary inbound messages when the field is present', async () => {
    const a = createWhatsAppAdapter(config);
    const body = {
      object: 'whatsapp_business_account',
      entry: [
        {
          id: 'waba-1',
          changes: [
            {
              field: 'messages',
              value: {
                messaging_product: 'whatsapp',
                metadata: { phone_number_id: '123456789' },
                messages: [
                  { from: '919999999999', id: 'wamid.IN', timestamp: '1750000000', type: 'text', text: { body: 'hello' } },
                ],
              },
            },
          ],
        },
      ],
    };
    const msgs = await a.handleWebhook(asRequest(body));
    expect(msgs).toHaveLength(1);
    expect(msgs[0]!.content).toEqual({ type: 'text', text: 'hello' });
  });

  it('parses message echoes, addressing the customer rather than the sender', () => {
    const echoes = createWhatsAppAdapter(config).parseMessageEchoes(echoBody);
    expect(echoes).toHaveLength(1);
    expect(echoes[0]).toMatchObject({
      externalId: 'wamid.ECHO',
      // `to`, not `from` — on an echo the business is the sender.
      contact: { channel: 'whatsapp', channelUserId: '919999999999' },
      account: { channel: 'whatsapp', channelAccountId: '123456789' },
      content: { type: 'text', text: 'sent from my phone' },
    });
  });

  it('parses history with per-message direction and chunk progress', () => {
    const chunks = createWhatsAppAdapter(config).parseHistory(historyBody);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toMatchObject({ phase: 'BACKFILL', chunkOrder: 1, progress: 40 });

    const msgs = chunks[0]!.threads[0]!.messages;
    expect(chunks[0]!.threads[0]!.contactId).toBe('919999999999');
    expect(msgs[0]).toMatchObject({ externalId: 'wamid.IN', direction: 'inbound', status: 'DELIVERED' });
    // "+1 555-0100" and "15550100" are the same number in different formats.
    expect(msgs[1]).toMatchObject({ externalId: 'wamid.OUT', direction: 'outbound' });
  });

  it('parses synced contacts and skips unknown state_sync kinds', () => {
    const contacts = createWhatsAppAdapter(config).parseContactSync(contactsBody);
    expect(contacts).toHaveLength(1);
    expect(contacts[0]).toMatchObject({
      phoneNumber: '919999999999',
      fullName: 'Asha Rao',
      firstName: 'Asha',
      action: 'add',
    });
  });

  it('returns [] when a parser is handed an unrelated payload', () => {
    const a = createWhatsAppAdapter(config);
    expect(a.parseMessageEchoes(historyBody)).toEqual([]);
    expect(a.parseHistory(contactsBody)).toEqual([]);
    expect(a.parseContactSync(echoBody)).toEqual([]);
    expect(a.parseHistory({})).toEqual([]);
    expect(a.parseMessageEchoes(undefined)).toEqual([]);
  });

  it('advertises the 20 mps ceiling only when coexistence is set', () => {
    expect(createWhatsAppAdapter(config).rateLimit).toBeUndefined();
    expect(createWhatsAppAdapter({ ...config, coexistence: true }).rateLimit).toEqual({
      perSecond: 20,
    });
  });

  it('requests contact and history sync', async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({ success: true }) } as Response;
    }) as unknown as typeof fetch;

    await createWhatsAppAdapter(config).requestSmbAppData();
    expect(calls[0]!.url).toContain('/123456789/smb_app_data');
    expect(JSON.parse(calls[0]!.init!.body as string)).toMatchObject({
      messaging_product: 'whatsapp',
      history_sync: true,
    });
  });

  it('reports coexistence status from is_on_biz_app', async () => {
    globalThis.fetch = vi.fn().mockImplementation(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ is_on_biz_app: true, platform_type: 'CLOUD_API' }),
    })) as unknown as typeof fetch;

    expect(await createWhatsAppAdapter(config).getCoexistenceStatus()).toEqual({
      isOnBusinessApp: true,
      platformType: 'CLOUD_API',
    });
  });

  it('exports the webhook fields coexistence requires', async () => {
    const { COEXISTENCE_WEBHOOK_FIELDS } = await import('../src/index.js');
    expect([...COEXISTENCE_WEBHOOK_FIELDS]).toEqual([
      'messages',
      'history',
      'smb_app_state_sync',
      'smb_message_echoes',
    ]);
  });
});
