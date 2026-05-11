import type { Adapter, AdapterCapabilities, MessageContent } from '@msgly/core';

import { createMetaGraphBase, type MetaGraphConfig } from './meta-base.js';

export type InstagramConfig = MetaGraphConfig;

export interface InstagramAdapter extends Adapter {
  readonly channel: 'instagram';
}

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: false, file: false },
  interactive: { buttons: false, quickReplies: true },
  templates: false,
  reactions: true,
  typing: false,
};

/**
 * Instagram Direct adapter.
 *
 * Instagram speaks the same Graph API surface as Messenger but with tighter
 * rules: stricter 24-hour window, no audio/file sends, no persistent buttons.
 * The hub's capability check normally enforces these, but we also guard at
 * the message-shape level for defense-in-depth.
 */
export function createInstagramAdapter(config: InstagramConfig): InstagramAdapter {
  const base = createMetaGraphBase('instagram', config, {
    toMetaMessage: (content: MessageContent) => {
      if (content.type === 'audio' || content.type === 'file') {
        throw new Error(`Instagram does not support sending ${content.type} messages`);
      }
      // Fall through to the default shape for everything else.
      switch (content.type) {
        case 'text':
          return { text: content.text };
        case 'image':
        case 'video':
          return {
            attachment: {
              type: content.type,
              payload: { url: content.mediaRef.value, is_reusable: true },
            },
          };
        case 'interactive':
          return {
            text: content.text,
            quick_replies: content.buttons.slice(0, 13).map((b) => ({
              content_type: 'text',
              title: b.label.slice(0, 20),
              payload: b.id.slice(0, 1000),
            })),
          };
        default:
          throw new Error(
            `Unsupported content type for instagram: ${(content as { type: string }).type}`,
          );
      }
    },
  });

  return {
    channel: 'instagram',
    capabilities: CAPABILITIES,
    ...base,
  };
}

export { createMetaGraphBase } from './meta-base.js';
export type { MetaGraphConfig, MetaGraphBase } from './meta-base.js';
