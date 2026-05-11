import { describe, expect, it } from 'vitest';

import { InstagramAdapter } from '../src/index.js';

const config = {
  pageAccessToken: 'ig-token',
  appSecret: 'app-secret',
  verifyToken: 'verify-token',
};

describe('InstagramAdapter', () => {
  it('declares correct channel and capabilities', () => {
    const a = new InstagramAdapter(config);
    expect(a.channel).toBe('instagram');
    expect(a.capabilities.media.audio).toBe(false);
    expect(a.capabilities.media.file).toBe(false);
    expect(a.capabilities.templates).toBe(false);
  });

  it('parses an inbound text message', async () => {
    const a = new InstagramAdapter(config);
    const body = {
      object: 'instagram',
      entry: [
        {
          id: 'ig-account',
          time: 1700000000000,
          messaging: [
            {
              sender: { id: 'user-ig' },
              recipient: { id: 'ig-account' },
              timestamp: 1700000000000,
              message: { mid: 'mid.ig.1', text: 'hello from ig' },
            },
          ],
        },
      ],
    };
    const messages = await a.handleWebhook({
      headers: {},
      rawBody: Buffer.from(''),
      body,
      query: {},
    });
    expect(messages).toHaveLength(1);
    expect(messages[0]!.channel).toBe('instagram');
  });

  it('verifyCredentials gives an Instagram-specific hint when token missing', async () => {
    const a = new InstagramAdapter({
      pageAccessToken: '',
      appSecret: 'x',
      verifyToken: 'y',
    });
    const result = await a.verifyCredentials();
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.hint).toContain('Instagram');
  });
});
