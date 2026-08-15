import type { Adapter, AdapterCapabilities } from '@msgly/core';

import { createMetaGraphBase, type MetaGraphConfig } from './meta-base.js';

export interface MessengerConfig extends MetaGraphConfig {
  /**
   * Facebook Page id, used by `publishPost`. Not needed for messaging, since
   * inbound events carry the Page id themselves.
   */
  pageId?: string;
}

export interface MessengerAdapter extends Adapter {
  readonly channel: 'messenger';
  /**
   * Publish a post to the Facebook Page feed.
   *
   * This is **content publishing, not messaging** — a Page post has no
   * recipient, so it sits outside `send()`. It is also the only broadcast
   * route Meta offers here: Messenger has no marketing broadcast, only the
   * 24-hour window and message tags.
   *
   * Requires `pages_manage_posts` on the Page token.
   */
  publishPost(options: {
    /** Page id. Defaults to `pageId` from the config. */
    pageId?: string;
    message?: string;
    /** Attaches a link preview to the post. */
    link?: string;
    /** Publishes a photo post instead; Facebook fetches the URL server-side. */
    photoUrl?: string;
  }): Promise<{ id: string }>;
}

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: true },
  interactive: { buttons: true, quickReplies: true },
  templates: false,
  reactions: false,
  typing: true,
};

/**
 * Plain-text formatter for Messenger. The Messenger Platform does not render
 * markdown or HTML in chat messages — these helpers return text as-is so code
 * that imports `fmt` from any adapter compiles uniformly.
 */
export const fmt = {
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  code: (t: string) => t,
  link: (t: string, _url: string) => t,
};

/**
 * Facebook Messenger adapter.
 *
 * The Messenger Platform enforces a 24-hour customer service window. After
 * that, you can only send messages with a valid messaging_type tag. This
 * adapter sends `RESPONSE` — fine for the standard reply-within-24h case.
 */
export function createMessengerAdapter(config: MessengerConfig): MessengerAdapter {
  async function publishPost(options: {
    pageId?: string;
    message?: string;
    link?: string;
    photoUrl?: string;
  }): Promise<{ id: string }> {
    const pageId = options.pageId ?? config.pageId;
    if (!pageId) {
      throw new Error(
        'publishPost needs the Page id — pass pageId, or set it in the adapter config.',
      );
    }
    if (!options.message && !options.photoUrl && !options.link) {
      throw new Error('publishPost needs at least one of message, link or photoUrl.');
    }

    const apiBase = `${config.apiBase ?? 'https://graph.facebook.com'}/${config.apiVersion ?? 'v20.0'}`;
    // A photo post uses a different edge from a plain status.
    const edge = options.photoUrl ? 'photos' : 'feed';

    const params = new URLSearchParams({
      access_token: config.pageAccessToken,
      ...(options.photoUrl
        ? { url: options.photoUrl, ...(options.message ? { caption: options.message } : {}) }
        : {
            ...(options.message ? { message: options.message } : {}),
            ...(options.link ? { link: options.link } : {}),
          }),
    });

    const res = await fetch(`${apiBase}/${encodeURIComponent(pageId)}/${edge}`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: params.toString(),
    });
    const data = (await res.json().catch(() => ({}))) as {
      id?: string;
      post_id?: string;
      error?: { message?: string };
    };

    const id = data.post_id ?? data.id;
    if (!res.ok || !id) {
      throw new Error(
        `Facebook publishPost failed: ${data.error?.message ?? `HTTP ${res.status}`}. ` +
          'The Page token needs the pages_manage_posts permission.',
      );
    }
    return { id };
  }

  const base = createMetaGraphBase('messenger', config);
  return {
    channel: 'messenger',
    capabilities: CAPABILITIES,
    ...base,
    publishPost,
  };
}

export { createMetaGraphBase } from './meta-base.js';
export type { MetaGraphConfig, MetaGraphBase } from './meta-base.js';
