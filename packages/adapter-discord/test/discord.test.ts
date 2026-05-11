import { describe, expect, it } from 'vitest';

import { createDiscordAdapter } from '../src/index.js';

const encode = (s: string) => new TextEncoder().encode(s);

function bytesToHex(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i]!.toString(16).padStart(2, '0');
  }
  return out;
}

const validHexKey = '0'.repeat(64);

const baseConfig = {
  applicationId: 'app-123',
  botToken: 'bot-token',
  publicKey: validHexKey,
};

describe('createDiscordAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = createDiscordAdapter(baseConfig);
    expect(a.channel).toBe('discord');
    expect(a.capabilities.text).toBe(true);
    expect(a.capabilities.interactive.buttons).toBe(true);
    expect(a.capabilities.templates).toBe(false);
  });

  it('acks PING with type 1 PONG', () => {
    const a = createDiscordAdapter(baseConfig);
    const ack = a.getInteractionAck?.({
      headers: {},
      rawBody: encode(''),
      body: { type: 1 },
      query: {},
    });
    expect(ack).toBe(JSON.stringify({ type: 1 }));
  });

  it('acks application command with type 5 (deferred channel message)', () => {
    const a = createDiscordAdapter(baseConfig);
    const ack = a.getInteractionAck?.({
      headers: {},
      rawBody: encode(''),
      body: { type: 2, data: { name: 'echo' } },
      query: {},
    });
    expect(ack).toBe(JSON.stringify({ type: 5 }));
  });

  it('acks message component with type 6 (deferred update)', () => {
    const a = createDiscordAdapter(baseConfig);
    const ack = a.getInteractionAck?.({
      headers: {},
      rawBody: encode(''),
      body: { type: 3, data: { custom_id: 'yes' } },
      query: {},
    });
    expect(ack).toBe(JSON.stringify({ type: 6 }));
  });

  it('returns no inbound messages for a PING', async () => {
    const a = createDiscordAdapter(baseConfig);
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: { type: 1 },
      query: {},
    });
    expect(messages).toHaveLength(0);
  });

  it('parses a slash command into a text inbound message with interaction metadata', async () => {
    const a = createDiscordAdapter(baseConfig);
    const interaction = {
      id: 'int-1',
      application_id: 'app-123',
      type: 2,
      channel_id: 'chan-9',
      guild_id: 'guild-5',
      token: 'tok-abc',
      version: 1,
      data: {
        id: 'cmd-1',
        name: 'echo',
        options: [{ name: 'msg', value: 'hi there' }],
      },
      member: { user: { id: 'u-1', username: 'udesh' } },
    };

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: interaction,
      query: {},
    });

    expect(messages).toHaveLength(1);
    const m = messages[0]!;
    expect(m.channel).toBe('discord');
    expect((m.content as { text: string }).text).toBe('/echo msg=hi there');
    expect(m.contact.channelUserId).toBe('chan-9');
    expect(m.contact.displayName).toBe('udesh');
    expect(m.account.channelAccountId).toBe('app-123');
    expect(m.metadata?.interactionToken).toBe('tok-abc');
    expect(m.metadata?.guildId).toBe('guild-5');
    expect(m.metadata?.userId).toBe('u-1');
  });

  it('parses a button click into text using the custom_id', async () => {
    const a = createDiscordAdapter(baseConfig);
    const interaction = {
      id: 'int-2',
      application_id: 'app-123',
      type: 3,
      channel_id: 'chan-9',
      token: 'tok-xyz',
      version: 1,
      data: { custom_id: 'confirm_yes', component_type: 2 },
      user: { id: 'u-2', username: 'someone' },
    };

    const messages = await a.handleWebhook({
      headers: {},
      rawBody: encode(''),
      body: interaction,
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect((messages[0]!.content as { text: string }).text).toBe('confirm_yes');
  });

  it('verifyCredentials returns hint when token is empty', async () => {
    const a = createDiscordAdapter({ ...baseConfig, botToken: '' });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toBe('unauthorized');
      expect(result.hint).toContain('Bot');
    }
  });

  it('verifySignature rejects missing headers', async () => {
    const a = createDiscordAdapter(baseConfig);
    const ok = await a.verifySignature({
      headers: {},
      rawBody: encode(''),
      body: {},
      query: {},
    });
    expect(ok).toBe(false);
  });

  it('verifySignature verifies a real Ed25519 signature end-to-end', async () => {
    // Generate a real Ed25519 keypair, sign a fixed body+timestamp, then make
    // sure the adapter accepts it. Requires WebCrypto Ed25519 (Node 20.13+,
    // Bun, Deno, Edge runtimes).
    let keyPair: CryptoKeyPair;
    try {
      keyPair = (await globalThis.crypto.subtle.generateKey(
        { name: 'Ed25519' },
        true,
        ['sign', 'verify'],
      )) as CryptoKeyPair;
    } catch {
      // Runtime doesn't support Ed25519 in WebCrypto — skip this test.
      console.warn('Skipping Ed25519 test: runtime does not support WebCrypto Ed25519');
      return;
    }

    const pubKeyRaw = new Uint8Array(
      await globalThis.crypto.subtle.exportKey('raw', keyPair.publicKey),
    );
    const publicKey = bytesToHex(pubKeyRaw);

    const a = createDiscordAdapter({ ...baseConfig, publicKey });

    const timestamp = '1700000000';
    const rawBody = encode('{"type":1}');
    const message = new Uint8Array(timestamp.length + rawBody.length);
    message.set(encode(timestamp), 0);
    message.set(rawBody, timestamp.length);

    const sig = new Uint8Array(
      await globalThis.crypto.subtle.sign(
        'Ed25519',
        keyPair.privateKey,
        message as BufferSource,
      ),
    );

    const ok = await a.verifySignature({
      headers: {
        'x-signature-ed25519': bytesToHex(sig),
        'x-signature-timestamp': timestamp,
      },
      rawBody,
      body: { type: 1 },
      query: {},
    });
    expect(ok).toBe(true);

    // Tamper the timestamp — signature should no longer verify.
    const bad = await a.verifySignature({
      headers: {
        'x-signature-ed25519': bytesToHex(sig),
        'x-signature-timestamp': '1700000001',
      },
      rawBody,
      body: { type: 1 },
      query: {},
    });
    expect(bad).toBe(false);
  });
});
