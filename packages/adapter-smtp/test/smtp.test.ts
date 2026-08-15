import { Readable } from 'node:stream';

import { describe, expect, it, vi } from 'vitest';

import {
  collectAttachmentsFromBodyStructure,
  createSmtpAdapter,
  type ImapClientLike,
  type ImapMessageLike,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const smtpServer = {
  host: 'smtp.mail.yahoo.com',
  port: 465,
  secure: true,
  auth: { user: 'agent@yahoo.com', pass: 'app-specific-password' },
};

const imapServer = {
  host: 'imap.mail.yahoo.com',
  port: 993,
  secure: true,
  auth: { user: 'agent@yahoo.com', pass: 'app-specific-password' },
};

/** Records what was handed to nodemailer without opening a socket. */
function fakeTransport(overrides: Record<string, unknown> = {}) {
  const sent: Record<string, unknown>[] = [];
  const transport = {
    sendMail: vi.fn(async (mail: Record<string, unknown>) => {
      sent.push(mail);
      return { messageId: '<generated@yahoo.com>', rejected: [] };
    }),
    verify: vi.fn(async () => true),
    close: vi.fn(),
    ...overrides,
  };
  return { transport, sent };
}

function fakeImap(messages: ImapMessageLike[], downloadBody = 'FILE-BYTES') {
  const released: boolean[] = [];
  const client: ImapClientLike = {
    connect: vi.fn(async () => {}),
    logout: vi.fn(async () => {}),
    getMailboxLock: vi.fn(async () => ({
      release: () => released.push(true),
    })),
    fetch: vi.fn(() => {
      return (async function* () {
        for (const m of messages) yield m;
      })();
    }),
    download: vi.fn(async () => ({
      content: Readable.from([Buffer.from(downloadBody)]) as NodeJS.ReadableStream,
    })),
    on: vi.fn(),
  };
  return { client, released };
}

function baseConfig(extra: Record<string, unknown> = {}) {
  const { transport, sent } = fakeTransport();
  return {
    sent,
    transport,
    config: {
      smtp: smtpServer,
      emailAddress: 'agent@yahoo.com',
      createTransport: () => transport as never,
      ...extra,
    },
  };
}

describe('createSmtpAdapter', () => {
  it('declares the smtp channel and no media until attachments are enabled', () => {
    const { config } = baseConfig();
    const a = createSmtpAdapter(config as never);
    expect(a.channel).toBe('smtp');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.media.file).toBe(false);
    expect(a.capabilities.interactive.buttons).toBe(false);

    const on = createSmtpAdapter({
      ...config,
      attachments: { enabled: true },
    } as never);
    expect(on.capabilities.media.file).toBe(true);
  });

  it('sends a plain-text email with a display name', async () => {
    const { config, sent } = baseConfig({ displayName: 'Acme Support' });
    const a = createSmtpAdapter(config as never);

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'hello there' },
      timestamp: new Date().toISOString(),
      metadata: { subject: 'Order update' },
    });

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('<generated@yahoo.com>');
    expect(sent[0]).toMatchObject({
      from: '"Acme Support" <agent@yahoo.com>',
      to: 'alice@example.com',
      subject: 'Order update',
      text: 'hello there',
    });
    expect(sent[0]).not.toHaveProperty('html');
  });

  it('sends HTML when format is html', async () => {
    const { config, sent } = baseConfig();
    const a = createSmtpAdapter(config as never);

    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: '<b>hi</b>', format: 'html' },
      timestamp: new Date().toISOString(),
    });

    expect(sent[0]!.html).toBe('<b>hi</b>');
    expect(sent[0]).not.toHaveProperty('text');
  });

  it('adds exactly one Re: prefix and threads the reply', async () => {
    const { config, sent } = baseConfig();
    const a = createSmtpAdapter(config as never);

    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'replying' },
      timestamp: new Date().toISOString(),
      metadata: {
        subject: 'Re: Re: Original',
        messageId: '<orig@example.com>',
        references: '<older@example.com>',
      },
    });

    expect(sent[0]!.subject).toBe('Re: Original');
    expect(sent[0]!.inReplyTo).toBe('<orig@example.com>');
    expect(sent[0]!.references).toBe('<older@example.com> <orig@example.com>');
  });

  it('strips CRLF from header values to prevent header injection', async () => {
    const { config, sent } = baseConfig();
    const a = createSmtpAdapter(config as never);

    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com\r\nBcc: evil@x.com' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
      metadata: { subject: 'Hello\r\nX-Injected: yes' },
    });

    expect(sent[0]!.to).toBe('alice@example.comBcc: evil@x.com');
    expect(String(sent[0]!.to)).not.toMatch(/[\r\n]/);
    expect(String(sent[0]!.subject)).not.toMatch(/[\r\n]/);
  });

  it('reports a rejected recipient as a failed receipt', async () => {
    const { transport } = fakeTransport({
      sendMail: vi.fn(async () => ({
        messageId: '<x@y>',
        rejected: ['bounce@example.com'],
      })),
    });
    const a = createSmtpAdapter({
      smtp: smtpServer,
      emailAddress: 'agent@yahoo.com',
      createTransport: () => transport as never,
    } as never);

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'bounce@example.com' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('smtp_rejected');
    expect(receipt.error?.message).toContain('bounce@example.com');
  });

  it('surfaces an SMTP response code on failure', async () => {
    const { transport } = fakeTransport({
      sendMail: vi.fn(async () => {
        throw Object.assign(new Error('Invalid login'), { responseCode: 535 });
      }),
    });
    const a = createSmtpAdapter({
      smtp: smtpServer,
      emailAddress: 'agent@yahoo.com',
      createTransport: () => transport as never,
    } as never);

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('smtp_535');
  });

  it('rejects non-text content with a clear error', async () => {
    const { config } = baseConfig();
    const a = createSmtpAdapter(config as never);

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } },
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('smtp_unsupported_content');
  });

  it('attaches uploaded files when attachments are enabled', async () => {
    const { config, sent } = baseConfig({ attachments: { enabled: true } });
    const a = createSmtpAdapter(config as never);

    const ref = await a.uploadMedia({
      data: encode('PDF-BYTES'),
      mimeType: 'application/pdf',
      filename: 'invoice.pdf',
    });

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'invoice attached' },
      attachments: [
        { mediaRef: ref, filename: 'invoice.pdf', mimeType: 'application/pdf' },
      ],
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('sent');
    const attachments = sent[0]!.attachments as Array<Record<string, unknown>>;
    expect(attachments).toHaveLength(1);
    expect(attachments[0]!.filename).toBe('invoice.pdf');
    expect(attachments[0]!.contentType).toBe('application/pdf');
    expect((attachments[0]!.content as Buffer).toString()).toBe('PDF-BYTES');
  });

  it('refuses uploadMedia while attachments are disabled', async () => {
    const { config } = baseConfig();
    const a = createSmtpAdapter(config as never);
    await expect(
      a.uploadMedia({ data: encode('x'), mimeType: 'text/plain' }),
    ).rejects.toThrow('attachments: { enabled: true }');
  });

  it('enforces maxSizeBytes before handing anything to the server', async () => {
    const { config, sent } = baseConfig({
      attachments: { enabled: true, maxSizeBytes: 4 },
    });
    const a = createSmtpAdapter(config as never);
    const ref = await a.uploadMedia({
      data: encode('far too many bytes'),
      mimeType: 'text/plain',
      filename: 'big.txt',
    });

    const receipt = await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'here' },
      attachments: [{ mediaRef: ref, filename: 'big.txt', mimeType: 'text/plain' }],
      timestamp: new Date().toISOString(),
    });

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.message).toContain('over the 4 byte limit');
    expect(sent).toHaveLength(0);
  });

  it('parses inbound mail from IMAP into a unified message', async () => {
    const { client } = fakeImap([
      {
        uid: 42,
        envelope: {
          messageId: '<abc@example.com>',
          subject: 'Hello agent',
          date: new Date('2026-01-01T10:00:00Z'),
          from: [{ name: 'Alice', address: 'alice@example.com' }],
        },
        bodyParts: new Map([['1', encode('hi from email')]]),
      },
    ]);

    const { config } = baseConfig({
      imap: imapServer,
      createImapClient: () => client,
    });
    const a = createSmtpAdapter(config as never);

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('smtp');
    expect(m.direction).toBe('inbound');
    expect((m.content as { text: string }).text).toBe('hi from email');
    expect(m.contact.channelUserId).toBe('alice@example.com');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.externalId).toBe('<abc@example.com>');
    expect(m.metadata?.subject).toBe('Hello agent');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
    expect(a.lastUid).toBe(42);
  });

  it('does not re-emit mail it has already seen', async () => {
    const message: ImapMessageLike = {
      uid: 7,
      envelope: { from: [{ address: 'bob@example.com' }], date: new Date() },
      bodyParts: new Map([['1', encode('first')]]),
    };
    const { client } = fakeImap([message]);
    const { config } = baseConfig({ imap: imapServer, createImapClient: () => client });
    const a = createSmtpAdapter(config as never);

    const req = { headers: {}, rawBody: encode(''), body: {}, query: {} };
    expect(await a.handleWebhook(req)).toHaveLength(1);
    // Same UID served again — the cursor must filter it out.
    expect(await a.handleWebhook(req)).toHaveLength(0);
  });

  it('resumes from a persisted UID cursor across restarts', async () => {
    const store = new Map<string, string>([['msgly:smtp:agent@yahoo.com:lastUid', '100']]);
    const stateStore = {
      get: async (k: string) => store.get(k) ?? null,
      set: async (k: string, v: string) => void store.set(k, v),
    };
    const { client } = fakeImap([
      {
        uid: 99, // older than the cursor — must be skipped
        envelope: { from: [{ address: 'old@example.com' }], date: new Date() },
        bodyParts: new Map([['1', encode('stale')]]),
      },
      {
        uid: 101,
        envelope: { from: [{ address: 'new@example.com' }], date: new Date() },
        bodyParts: new Map([['1', encode('fresh')]]),
      },
    ]);

    const { config } = baseConfig({
      imap: imapServer,
      createImapClient: () => client,
      stateStore,
    });
    const a = createSmtpAdapter(config as never);

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });

    expect(messages).toHaveLength(1);
    expect(messages[0]!.contact.channelUserId).toBe('new@example.com');
    expect(store.get('msgly:smtp:agent@yahoo.com:lastUid')).toBe('101');
  });

  it('falls back to the HTML part when there is no plain-text body', async () => {
    const { client } = fakeImap([
      {
        uid: 5,
        envelope: { from: [{ address: 'bob@example.com' }], date: new Date() },
        bodyParts: new Map([['2', encode('<p>html <b>only</b></p>')]]),
      },
    ]);
    const { config } = baseConfig({ imap: imapServer, createImapClient: () => client });
    const a = createSmtpAdapter(config as never);

    const [m] = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect((m!.content as { text: string }).text).toBe('html only');
  });

  it('surfaces inbound attachments lazily, and only when enabled', async () => {
    const bodyStructure = {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        {
          part: '2',
          type: 'application/pdf',
          disposition: 'attachment',
          dispositionParameters: { filename: 'deck.pdf' },
          size: 2048,
        },
      ],
    };
    const message: ImapMessageLike = {
      uid: 9,
      envelope: { from: [{ address: 'bob@example.com' }], date: new Date() },
      bodyParts: new Map([['1', encode('see attached')]]),
      bodyStructure,
    };

    const on = createSmtpAdapter({
      ...baseConfig({
        imap: imapServer,
        createImapClient: () => fakeImap([message]).client,
        attachments: { enabled: true },
      }).config,
    } as never);

    const [withAtt] = await on.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(withAtt!.attachments).toHaveLength(1);
    expect(withAtt!.attachments![0]).toMatchObject({
      filename: 'deck.pdf',
      mimeType: 'application/pdf',
      size: 2048,
    });
    // Lazy: a reference to the IMAP part, no bytes fetched.
    expect(withAtt!.attachments![0]!.mediaRef.value).toBe('9:2');

    const off = createSmtpAdapter({
      ...baseConfig({
        imap: imapServer,
        createImapClient: () => fakeImap([message]).client,
      }).config,
    } as never);
    const [plain] = await off.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(plain!.attachments).toBeUndefined();
  });

  it('downloads an attachment body part on demand', async () => {
    const { client } = fakeImap([], 'REPORT-CONTENT');
    const { config } = baseConfig({
      imap: imapServer,
      createImapClient: () => client,
      attachments: { enabled: true },
    });
    const a = createSmtpAdapter(config as never);

    const file = await a.downloadMedia({
      kind: 'platform-id',
      value: '42:2',
      mimeType: 'text/csv',
      filename: 'report.csv',
    });

    expect(client.download).toHaveBeenCalledWith('42', '2', { uid: true });
    expect(new TextDecoder().decode(file.data as Uint8Array)).toBe('REPORT-CONTENT');
    expect(file.filename).toBe('report.csv');
  });

  it('is send-only when no imap config is supplied', async () => {
    const { config } = baseConfig();
    const a = createSmtpAdapter(config as never);

    await a.start(); // must not throw or connect
    expect(
      await a.handleWebhook({ headers: {}, rawBody: encode(''), body: {}, query: {} }),
    ).toEqual([]);
  });

  it('verifyCredentials succeeds when the server accepts the login', async () => {
    const { config } = baseConfig();
    const result = await createSmtpAdapter(config as never).verifyCredentials();
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accountInfo).toContain('smtp.mail.yahoo.com');
  });

  it('verifyCredentials hints about app-specific passwords on auth failure', async () => {
    const { transport } = fakeTransport({
      verify: vi.fn(async () => {
        throw new Error('535 Authentication failed');
      }),
    });
    const result = await createSmtpAdapter({
      smtp: smtpServer,
      emailAddress: 'agent@yahoo.com',
      createTransport: () => transport as never,
    } as never).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('app-specific password');
    }
  });

  it('verifyCredentials reports an empty password without dialling out', async () => {
    const result = await createSmtpAdapter({
      smtp: { ...smtpServer, auth: { user: 'agent@yahoo.com', pass: '' } },
      emailAddress: 'agent@yahoo.com',
    } as never).verifyCredentials();

    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('app-specific password');
  });
});

describe('collectAttachmentsFromBodyStructure', () => {
  it('ignores multipart containers and the text body', () => {
    const found = collectAttachmentsFromBodyStructure(1, {
      type: 'multipart/mixed',
      childNodes: [
        { part: '1', type: 'text/plain' },
        {
          part: '2',
          type: 'image/png',
          disposition: 'inline',
          id: '<logo123>',
          dispositionParameters: { filename: 'logo.png' },
        },
      ],
    });

    expect(found).toHaveLength(1);
    expect(found[0]!.inline).toBe(true);
    expect(found[0]!.contentId).toBe('logo123');
  });

  it('recurses into nested multiparts', () => {
    const found = collectAttachmentsFromBodyStructure(3, {
      type: 'multipart/mixed',
      childNodes: [
        {
          type: 'multipart/alternative',
          childNodes: [
            { part: '1.1', type: 'text/plain' },
            { part: '1.2', type: 'text/html' },
          ],
        },
        {
          part: '2',
          type: 'application/zip',
          disposition: 'attachment',
          dispositionParameters: { filename: 'bundle.zip' },
        },
      ],
    });

    expect(found.map((a) => a.filename)).toEqual(['bundle.zip']);
    expect(found[0]!.mediaRef.value).toBe('3:2');
  });

  it('falls back to the content-type name when no filename is given', () => {
    const found = collectAttachmentsFromBodyStructure(4, {
      type: 'multipart/mixed',
      childNodes: [
        {
          part: '2',
          type: 'application/octet-stream',
          disposition: 'attachment',
          parameters: { name: 'from-name-param.bin' },
        },
      ],
    });
    expect(found[0]!.filename).toBe('from-name-param.bin');
  });
});

describe('List-Unsubscribe', () => {
  it('emits one-click headers from adapter config', async () => {
    const { config, sent } = baseConfig({
      unsubscribe: { url: 'https://acme.com/u?e={{contact}}', mailto: 'unsub@acme.com' },
    });
    const a = createSmtpAdapter(config as never);

    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'campaign' },
      timestamp: new Date().toISOString(),
    });

    const headers = sent[0]!.headers as Record<string, string>;
    expect(headers['List-Unsubscribe']).toBe(
      '<mailto:unsub@acme.com>, <https://acme.com/u?e=alice%40example.com>',
    );
    expect(headers['List-Unsubscribe-Post']).toBe('List-Unsubscribe=One-Click');
  });

  it('strips CRLF from unsubscribe headers too', async () => {
    const { config, sent } = baseConfig({
      unsubscribe: { mailto: 'unsub@acme.com\r\nBcc: evil@x.com' },
    });
    const a = createSmtpAdapter(config as never);

    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'x' },
      timestamp: new Date().toISOString(),
    });

    const headers = sent[0]!.headers as Record<string, string>;
    expect(String(headers['List-Unsubscribe'])).not.toMatch(/[\r\n]/);
  });

  it('omits the headers when not configured', async () => {
    const { config, sent } = baseConfig();
    const a = createSmtpAdapter(config as never);
    await a.send({
      id: 'm-1',
      direction: 'outbound',
      channel: 'smtp',
      account: { channel: 'smtp', channelAccountId: 'agent@yahoo.com' },
      contact: { channel: 'smtp', channelUserId: 'alice@example.com' },
      content: { type: 'text', text: 'hi' },
      timestamp: new Date().toISOString(),
    });
    expect(sent[0]!.headers).toBeUndefined();
  });
});
