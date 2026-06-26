import type { Adapter, AdapterCapabilities } from '@msgly/core';

import { createMetaGraphBase, type MetaGraphConfig } from './meta-base.js';

export type MessengerConfig = MetaGraphConfig;

export interface MessengerAdapter extends Adapter {
  readonly channel: 'messenger';
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
  const base = createMetaGraphBase('messenger', config);
  return {
    channel: 'messenger',
    capabilities: CAPABILITIES,
    ...base,
  };
}

export { createMetaGraphBase } from './meta-base.js';
export type { MetaGraphConfig, MetaGraphBase } from './meta-base.js';
