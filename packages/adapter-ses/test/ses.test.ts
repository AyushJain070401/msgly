import { createHmac, createHash } from 'node:crypto';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  buildRawMime,
  createSesAdapter,
  isValidSigningCertUrl,
  parseAddress,
  signRequest,
} from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

const credentials = {
  accessKeyId: 'AKIAIOSFODNN7EXAMPLE',
  secretAccessKey: 'wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY',
};

const baseConfig = {
  region: 'us-east-1',
  credentials,
  from: 'Acme <hello@acme.com>',
  apiHost: 'email.us-east-1.amazonaws.com',
  skipSnsVerification: true,
};

const account = { channel: 'ses' as const, channelAccountId: 'hello@acme.com' };
const contact = { channel: 'ses' as const, channelUserId: 'alice@example.com' };

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

function mockApi(payload: unknown, status = 200) {
  const calls: Array<{ url: string; init?: RequestInit }> = [];
  globalThis.fetch = vi.fn().mockImplementation(async (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => payload } as Response;
  }) as unknown as typeof fetch;
  return calls;
}

function outbound(
  content: Parameters<ReturnType<typeof createSesAdapter>['send']>[0]['content'],
  extra: Record<string, unknown> = {},
) {
  return {
    id: 'm-1',
    direction: 'outbound' as const,
    channel: 'ses' as const,
    account,
    contact,
    content,
    timestamp: new Date().toISOString(),
    ...extra,
  };
}

function sns(message: unknown, envelope: Record<string, unknown> = {}) {
  return {
    headers: {},
    rawBody: encode(''),
    query: {},
    body: {
      Type: 'Notification',
      MessageId: 'sns-1',
      Message: typeof message === 'string' ? message : JSON.stringify(message),
      ...envelope,
    },
  };
}

describe('signRequest', () => {
  /**
   * AWS publishes a worked example for SigV4. Reproducing it independently
   * with node:crypto proves the implementation, rather than restating it.
   */
  it('matches an independent SigV4 computation', async () => {
    const now = new Date('2026-08-15T14:30:00Z');
    const signed = await signRequest({
      method: 'POST',
      host: 'email.us-east-1.amazonaws.com',
      path: '/v2/email/outbound-emails',
      body: '{"a":1}',
      region: 'us-east-1',
      service: 'ses',
      credentials,
      now,
    });

    const amzDate = '20260815T143000Z';
    const dateStamp = '20260815';
    const payloadHash = createHash('sha256').update('{"a":1}').digest('hex');

    const canonicalHeaders =
      `host:email.us-east-1.amazonaws.com\n` +
      `x-amz-content-sha256:${payloadHash}\n` +
      `x-amz-date:${amzDate}\n`;
    const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
    const canonicalRequest = [
      'POST',
      '/v2/email/outbound-emails',
      '',
      canonicalHeaders,
      signedHeaders,
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/us-east-1/ses/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const kDate = createHmac('sha256', `AWS4${credentials.secretAccessKey}`)
      .update(dateStamp).digest();
    const kRegion = createHmac('sha256', kDate).update('us-east-1').digest();
    const kService = createHmac('sha256', kRegion).update('ses').digest();
    const kSigning = createHmac('sha256', kService).update('aws4_request').digest();
    const expected = createHmac('sha256', kSigning).update(stringToSign).digest('hex');

    expect(signed.headers.authorization).toContain(`Signature=${expected}`);
    expect(signed.headers.authorization).toContain(
      `Credential=${credentials.accessKeyId}/${scope}`,
    );
    expect(signed.headers['x-amz-date']).toBe(amzDate);
  });

  it('includes the session token when using temporary credentials', async () => {
    const signed = await signRequest({
      method: 'GET',
      host: 'email.us-east-1.amazonaws.com',
      path: '/v2/email/account',
      body: '',
      region: 'us-east-1',
      service: 'ses',
      credentials: { ...credentials, sessionToken: 'FwoGZXIvYXdz' },
    });

    expect(signed.headers['x-amz-security-token']).toBe('FwoGZXIvYXdz');
    // A signature that omitted the token header would be rejected by AWS.
    expect(signed.headers.authorization).toContain('x-amz-security-token');
  });
});

describe('createSesAdapter', () => {
  it('declares the ses channel with attachments off by default', () => {
    const a = createSesAdapter(baseConfig);
    expect(a.channel).toBe('ses');
    expect(a.capabilities.media.file).toBe(false);
    expect(
      createSesAdapter({ ...baseConfig, attachments: { enabled: true } }).capabilities.media
        .file,
    ).toBe(true);
  });

  it('sends a plain email through the Simple content shape', async () => {
    const calls = mockApi({ MessageId: 'ses-msg-1' });
    const a = createSesAdapter(baseConfig);
    const receipt = await a.send(
      outbound({ type: 'text', text: 'hello' }, { metadata: { subject: 'Hi' } }),
    );

    expect(receipt.status).toBe('sent');
    expect(receipt.externalId).toBe('ses-msg-1');
    expect(calls[0]!.url).toBe(
      'https://email.us-east-1.amazonaws.com/v2/email/outbound-emails',
    );
    expect(
      (calls[0]!.init!.headers as Record<string, string>).authorization,
    ).toContain('AWS4-HMAC-SHA256');

    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.FromEmailAddress).toBe('Acme <hello@acme.com>');
    expect(body.Destination.ToAddresses).toEqual(['alice@example.com']);
    expect(body.Content.Simple.Subject.Data).toBe('Hi');
    expect(body.Content.Simple.Body.Text.Data).toBe('hello');
    expect(body.Content.Raw).toBeUndefined();
  });

  it('uses HTML in the Simple shape when the format says so', async () => {
    const calls = mockApi({ MessageId: 'm' });
    await createSesAdapter(baseConfig).send(
      outbound({ type: 'text', text: '<b>hi</b>', format: 'html' }),
    );
    const body = JSON.parse(calls[0]!.init!.body as string);
    expect(body.Content.Simple.Body.Html.Data).toBe('<b>hi</b>');
  });

  it('switches to Raw MIME when unsubscribe headers are needed', async () => {
    const calls = mockApi({ MessageId: 'm' });
    const a = createSesAdapter({
      ...baseConfig,
      unsubscribe: { url: 'https://acme.com/u?e={{contact}}' },
    });
    await a.send(outbound({ type: 'text', text: 'campaign' }));

    const body = JSON.parse(calls[0]!.init!.body as string);
    // Simple content cannot carry custom headers at all.
    expect(body.Content.Simple).toBeUndefined();
    const mime = atob(body.Content.Raw.Data);
    expect(mime).toContain('List-Unsubscribe: <https://acme.com/u?e=alice%40example.com>');
    expect(mime).toContain('List-Unsubscribe-Post: List-Unsubscribe=One-Click');
  });

  it('switches to Raw MIME for attachments', async () => {
    const calls = mockApi({ MessageId: 'm' });
    const a = createSesAdapter({ ...baseConfig, attachments: { enabled: true } });
    const ref = await a.uploadMedia({
      data: encode('PDF'),
      mimeType: 'application/pdf',
      filename: 'r.pdf',
    });
    await a.send(
      outbound({ type: 'text', text: 'attached' }, {
        attachments: [{ mediaRef: ref, filename: 'r.pdf', mimeType: 'application/pdf' }],
      }),
    );

    const mime = atob(JSON.parse(calls[0]!.init!.body as string).Content.Raw.Data);
    expect(mime).toContain('multipart/mixed');
    expect(mime).toContain('filename="r.pdf"');
    expect(mime).toContain(btoa('PDF'));
  });

  it('attaches the configuration set when configured', async () => {
    const calls = mockApi({ MessageId: 'm' });
    await createSesAdapter({ ...baseConfig, configurationSetName: 'cs-1' }).send(
      outbound({ type: 'text', text: 'x' }),
    );
    expect(JSON.parse(calls[0]!.init!.body as string).ConfigurationSetName).toBe('cs-1');
  });

  it('marks a rejected message as a permanent failure', async () => {
    mockApi({ __type: 'com.amazon.coral#MessageRejected', message: 'Email address is not verified' }, 400);
    const receipt = await createSesAdapter(baseConfig).send(
      outbound({ type: 'text', text: 'x' }),
    );

    expect(receipt.status).toBe('failed');
    expect(receipt.error?.code).toBe('ses_MessageRejected');
    // Retrying an unverified identity will never succeed.
    expect(receipt.error?.permanent).toBe(true);
  });

  it('treats throttling as retryable rather than permanent', async () => {
    mockApi({ __type: 'com.amazon.coral#TooManyRequestsException', message: 'slow down' }, 429);
    const receipt = await createSesAdapter(baseConfig).send(
      outbound({ type: 'text', text: 'x' }),
    );
    expect(receipt.error?.permanent).toBe(false);
  });

  it('enforces maxSizeBytes before calling AWS', async () => {
    const calls = mockApi({ MessageId: 'm' });
    const a = createSesAdapter({
      ...baseConfig,
      attachments: { enabled: true, maxSizeBytes: 2 },
    });
    const ref = await a.uploadMedia({
      data: encode('too big'),
      mimeType: 'text/plain',
      filename: 'b.txt',
    });
    const receipt = await a.send(
      outbound({ type: 'text', text: 'x' }, {
        attachments: [{ mediaRef: ref, filename: 'b.txt', mimeType: 'text/plain' }],
      }),
    );

    expect(receipt.error?.code).toBe('ses_attachment_error');
    expect(calls).toHaveLength(0);
  });

  it('rejects non-text content', async () => {
    const receipt = await createSesAdapter(baseConfig).send(
      outbound({ type: 'image', mediaRef: { kind: 'url', value: 'http://x/y.png' } }),
    );
    expect(receipt.error?.code).toBe('ses_unsupported_content');
  });

  it('maps a permanent bounce to a suppressible receipt, per recipient', () => {
    const receipts = createSesAdapter(baseConfig).parseDeliveryEvents(
      sns({
        notificationType: 'Bounce',
        mail: { messageId: 'm-1', timestamp: '2026-01-01T10:00:00.000Z' },
        bounce: {
          bounceType: 'Permanent',
          bounceSubType: 'General',
          bouncedRecipients: [
            { emailAddress: 'dead@example.com', diagnosticCode: '550 no such user' },
            { emailAddress: 'gone@example.com' },
          ],
        },
      }),
    );

    expect(receipts).toHaveLength(2);
    expect(receipts[0]).toMatchObject({
      externalId: 'm-1',
      status: 'failed',
      recipientId: 'dead@example.com',
    });
    expect(receipts[0]!.error).toMatchObject({ permanent: true });
    expect(receipts[0]!.error!.message).toBe('550 no such user');
  });

  it('leaves a transient bounce unsuppressed', () => {
    // A full mailbox is not a dead address — suppressing would lose a real
    // recipient.
    const [receipt] = createSesAdapter(baseConfig).parseDeliveryEvents(
      sns({
        notificationType: 'Bounce',
        mail: { messageId: 'm-2' },
        bounce: {
          bounceType: 'Transient',
          bounceSubType: 'MailboxFull',
          bouncedRecipients: [{ emailAddress: 'busy@example.com' }],
        },
      }),
    );
    expect(receipt!.error!.permanent).toBe(false);
  });

  it('maps a complaint to a suppressible receipt', () => {
    const [receipt] = createSesAdapter(baseConfig).parseDeliveryEvents(
      sns({
        notificationType: 'Complaint',
        mail: { messageId: 'm-3' },
        complaint: {
          complainedRecipients: [{ emailAddress: 'angry@example.com' }],
          complaintFeedbackType: 'abuse',
        },
      }),
    );
    expect(receipt!.error).toMatchObject({ permanent: true, complaint: true });
    expect(receipt!.recipientId).toBe('angry@example.com');
  });

  it('maps a delivery notification', () => {
    const receipts = createSesAdapter(baseConfig).parseDeliveryEvents(
      sns({
        notificationType: 'Delivery',
        mail: { messageId: 'm-4' },
        delivery: { recipients: ['a@x.com', 'b@x.com'] },
      }),
    );
    expect(receipts.map((r) => r.status)).toEqual(['delivered', 'delivered']);
  });

  it('ignores notifications it does not recognise', () => {
    const a = createSesAdapter(baseConfig);
    expect(a.parseDeliveryEvents(sns({ notificationType: 'Open', mail: { messageId: 'm' } }))).toEqual([]);
    expect(a.parseDeliveryEvents(sns('not json at all'))).toEqual([]);
  });

  it('surfaces an SNS subscription confirmation URL', () => {
    const a = createSesAdapter(baseConfig);
    const url = a.getSubscriptionConfirmationUrl({
      headers: {},
      rawBody: encode(''),
      query: {},
      body: {
        Type: 'SubscriptionConfirmation',
        SubscribeURL: 'https://sns.us-east-1.amazonaws.com/?Action=ConfirmSubscription',
      },
    });
    expect(url).toContain('ConfirmSubscription');

    expect(a.getSubscriptionConfirmationUrl(sns({ notificationType: 'Delivery' }))).toBeNull();
  });

  it('parses inbound mail from a receipt-rule notification', async () => {
    const rawEmail = [
      'From: Alice <alice@example.com>',
      'To: support@acme.com',
      'Subject: Need help',
      'Message-ID: <abc@example.com>',
      'Content-Type: text/plain; charset=utf-8',
      '',
      'my order never arrived',
    ].join('\r\n');

    const messages = await createSesAdapter(baseConfig).handleWebhook(
      sns({
        notificationType: 'Received',
        receipt: { recipients: ['support@acme.com'] },
        mail: {
          messageId: 'in-1',
          destination: ['support@acme.com'],
          timestamp: '2026-01-01T10:00:00.000Z',
        },
        content: btoa(rawEmail),
      }),
    );

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect((m.content as { text: string }).text).toBe('my order never arrived');
    expect(m.contact.channelUserId).toBe('alice@example.com');
    expect(m.contact.displayName).toBe('Alice');
    expect(m.metadata?.subject).toBe('Need help');
    expect(m.metadata?.messageId).toBe('<abc@example.com>');
    expect(m.timestamp).toBe('2026-01-01T10:00:00.000Z');
  });

  it('keeps delivery events out of handleWebhook', async () => {
    const messages = await createSesAdapter(baseConfig).handleWebhook(
      sns({ notificationType: 'Bounce', mail: { messageId: 'm' }, bounce: {} }),
    );
    expect(messages).toEqual([]);
  });

  it('verifyCredentials warns loudly about the SES sandbox', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ SendingEnabled: true, ProductionAccessEnabled: false }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createSesAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(true);
    // Silently reaching almost nobody is the worst failure mode here.
    if (result.ok) expect(result.accountInfo).toContain('SANDBOX');
  });

  it('verifyCredentials reports a suspended account', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () =>
        ({
          ok: true,
          status: 200,
          json: async () => ({ SendingEnabled: false, EnforcementStatus: 'SHUTDOWN' }),
        }) as Response,
    ) as unknown as typeof fetch;

    const result = await createSesAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('SHUTDOWN');
  });

  it('verifyCredentials reports a 403 as unauthorized', async () => {
    globalThis.fetch = vi.fn().mockImplementation(
      async () => ({ ok: false, status: 403, json: async () => ({}) }) as Response,
    ) as unknown as typeof fetch;

    const result = await createSesAdapter(baseConfig).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.reason).toBe('unauthorized');
  });

  it('verifyCredentials returns a hint when credentials are missing', async () => {
    const result = await createSesAdapter({
      ...baseConfig,
      credentials: { accessKeyId: '', secretAccessKey: '' },
    }).verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('ses:SendEmail');
  });
});

describe('isValidSigningCertUrl', () => {
  it('accepts genuine SNS certificate URLs', () => {
    expect(
      isValidSigningCertUrl('https://sns.us-east-1.amazonaws.com/SimpleNotification-abc.pem'),
    ).toBe(true);
    expect(
      isValidSigningCertUrl('https://sns.cn-north-1.amazonaws.com.cn/x.pem'),
    ).toBe(true);
  });

  it('rejects URLs an attacker could point at their own key', () => {
    // The URL arrives inside the untrusted payload, so this check is what
    // stops a forged bounce from suppressing arbitrary recipients.
    for (const url of [
      'https://evil.com/cert.pem',
      'http://sns.us-east-1.amazonaws.com/x.pem', // not https
      'https://sns.us-east-1.amazonaws.com.evil.com/x.pem',
      'https://sns.us-east-1.amazonaws.com/x.txt', // not a .pem
      'https://notsns.us-east-1.amazonaws.com/x.pem',
      'not a url',
    ]) {
      expect(isValidSigningCertUrl(url)).toBe(false);
    }
  });
});

describe('buildRawMime', () => {
  it('emits a single-part message with extra headers', () => {
    const mime = buildRawMime({
      from: 'a@x.com',
      to: 'b@y.com',
      subject: 'Hi',
      body: 'hello',
      isHtml: false,
      extraHeaders: { 'List-Unsubscribe': '<https://u>' },
    });
    expect(mime).toContain('List-Unsubscribe: <https://u>');
    expect(mime).toContain('text/plain');
    expect(mime).not.toContain('multipart');
  });

  it('strips CRLF from header values', () => {
    const mime = buildRawMime({
      from: 'a@x.com',
      to: 'b@y.com\r\nBcc: evil@x.com',
      subject: 'Hi',
      body: 'x',
      isHtml: false,
    });
    expect(mime).not.toMatch(/\r\nBcc: evil@x\.com/);
  });

  it('uses multipart/related for inline attachments', () => {
    const mime = buildRawMime({
      from: 'a@x.com',
      to: 'b@y.com',
      subject: 'Hi',
      body: '<img src="cid:logo">',
      isHtml: true,
      attachments: [
        {
          bytes: encode('PNG'),
          filename: 'logo.png',
          mimeType: 'image/png',
          contentId: 'logo',
        },
      ],
    });
    expect(mime).toContain('multipart/related');
    expect(mime).toContain('Content-ID: <logo>');
  });
});

describe('parseAddress', () => {
  it('splits a display name from the address', () => {
    expect(parseAddress('Alice <a@x.com>')).toEqual({
      address: 'a@x.com',
      displayName: 'Alice',
    });
    expect(parseAddress('a@x.com')).toEqual({ address: 'a@x.com' });
  });
});
