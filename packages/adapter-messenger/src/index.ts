import type {
  AdapterCapabilities,
  ChannelName,
} from '@chatterbox/core';

import { MetaGraphAdapter, type MetaGraphConfig } from './meta-base.js';

export type MessengerConfig = MetaGraphConfig;

/**
 * Facebook Messenger adapter.
 *
 * Important: the Messenger Platform enforces a 24-hour customer service
 * window. After that, you can only send messages with a valid
 * messaging_type tag. This v0 sends "RESPONSE" — fine for the standard
 * reply-within-24h case. Add tagged messaging in a follow-up.
 */
export class MessengerAdapter extends MetaGraphAdapter {
  readonly channel: ChannelName = 'messenger';

  readonly capabilities: AdapterCapabilities = {
    text: true,
    media: { image: true, video: true, audio: true, file: true },
    interactive: { buttons: true, quickReplies: true },
    templates: false,
    reactions: false,
    typing: true,
  };
}

export { MetaGraphAdapter } from './meta-base.js';
