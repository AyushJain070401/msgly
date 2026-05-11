import type {
  AdapterCapabilities,
  ChannelName,
  MessageContent,
} from '@msgly/core';

import { MetaGraphAdapter, type MetaGraphConfig } from './meta-base.js';

export type InstagramConfig = MetaGraphConfig;

/**
 * Instagram Direct Messaging adapter.
 *
 * Instagram uses the same Graph API surface as Messenger but with
 * different permissions (instagram_manage_messages) and slightly tighter
 * rules: the 24-hour window is enforced more strictly, audio messages are
 * not supported on send, and templates are not available.
 *
 * Instagram-side webhook objects come in with object="instagram" rather
 * than "page" — but the messaging event shape is the same.
 */
export class InstagramAdapter extends MetaGraphAdapter {
  readonly channel: ChannelName = 'instagram';

  readonly capabilities: AdapterCapabilities = {
    text: true,
    // Audio sending is not supported on Instagram DMs.
    media: { image: true, video: true, audio: false, file: false },
    interactive: { buttons: false, quickReplies: true },
    templates: false,
    reactions: true,
    typing: false,
  };

  protected override toMetaMessage(
    content: MessageContent,
  ): Record<string, unknown> {
    if (content.type === 'audio' || content.type === 'file') {
      throw new Error(
        `Instagram does not support sending ${content.type} messages`,
      );
    }
    return super.toMetaMessage(content);
  }
}

export { MetaGraphAdapter } from './meta-base.js';
