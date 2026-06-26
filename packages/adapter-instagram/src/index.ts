import type { Adapter, AdapterCapabilities, MessageContent } from '@msgly/core';

import { createMetaGraphBase, type MetaGraphConfig } from './meta-base.js';

export interface InstagramConfig extends MetaGraphConfig {
  /**
   * Facebook App ID (from App Dashboard → General Information → App ID).
   * Required when using the Instagram Login OAuth helpers:
   * `getAuthUrl`, `exchangeCode`, `getLongLivedToken`, `refreshToken`.
   */
  appId?: string;
}

export interface InstagramTokenResult {
  accessToken: string;
  tokenType: string;
  /** Seconds until expiry. Omitted for short-lived tokens. */
  expiresIn?: number;
}

export interface InstagramAdapter extends Adapter {
  readonly channel: 'instagram';
  /**
   * Build the Instagram Login authorization URL. Direct users here to grant
   * your app access to their Instagram Business account.
   */
  getAuthUrl(options: {
    appId: string;
    redirectUri: string;
    /** Defaults to instagram_business_basic + instagram_business_manage_messages. */
    scopes?: string[];
    state?: string;
  }): string;
  /**
   * Exchange the `code` from the OAuth redirect for a short-lived user access
   * token (~1 hour). Call this in your redirect URI handler.
   */
  exchangeCode(
    code: string,
    options: { appId: string; appSecret: string; redirectUri: string },
  ): Promise<InstagramTokenResult>;
  /**
   * Exchange a short-lived token for a long-lived token (~60 days).
   * Uses the app secret from `config.appSecret` unless `appSecret` is passed.
   */
  getLongLivedToken(
    shortLivedToken: string,
    appSecret?: string,
  ): Promise<InstagramTokenResult>;
  /**
   * Refresh a long-lived token to extend its life by another 60 days.
   * Call at least 24 hours before it expires.
   */
  refreshToken(longLivedToken: string): Promise<InstagramTokenResult>;
}

const INSTAGRAM_AUTH_BASE = 'https://www.instagram.com/oauth/authorize';
const INSTAGRAM_TOKEN_BASE = 'https://api.instagram.com/oauth/access_token';
const INSTAGRAM_GRAPH_BASE = 'https://graph.instagram.com';

const DEFAULT_SCOPES = [
  'instagram_business_basic',
  'instagram_business_manage_messages',
];

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: false, file: false },
  interactive: { buttons: false, quickReplies: true },
  templates: false,
  reactions: true,
  typing: true,
};

/**
 * Plain-text formatter for Instagram. Instagram does not render markdown or
 * HTML in Direct Messages — these helpers return the text as-is so code that
 * imports `fmt` from any adapter compiles uniformly.
 */
export const fmt = {
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  code: (t: string) => t,
  link: (t: string, _url: string) => t,
};

/**
 * Instagram Direct adapter.
 *
 * Instagram speaks the same Graph API surface as Messenger but with tighter
 * rules: stricter 24-hour window, no audio/file sends, no persistent buttons.
 * The hub's capability check normally enforces these, but we also guard at
 * the message-shape level for defense-in-depth.
 *
 * **Authentication — two ways:**
 *
 * 1. **Facebook Login** (existing): Generate a Page Access Token via the Meta
 *    dashboard and set it as `config.pageAccessToken`. Fine for server-side bots.
 *
 * 2. **Instagram Login** (new in 0.3.0): Redirect the user to `adapter.getAuthUrl(...)`,
 *    exchange the returned code with `adapter.exchangeCode(...)`, upgrade to a
 *    long-lived token with `adapter.getLongLivedToken(...)`, and use that as
 *    `config.pageAccessToken`. Supports `instagram_business_manage_messages` scope.
 */
export function createInstagramAdapter(config: InstagramConfig): InstagramAdapter {
  const graphBase = INSTAGRAM_GRAPH_BASE;

  const base = createMetaGraphBase('instagram', config, {
    toMetaMessage: (content: MessageContent) => {
      if (content.type === 'audio' || content.type === 'file') {
        throw new Error(`Instagram does not support sending ${content.type} messages`);
      }
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
        case 'interactive': {
          const flat: import('@msgly/core').InteractiveButton[] = Array.isArray(content.buttons[0])
            ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
            : (content.buttons as import('@msgly/core').InteractiveButton[]);
          return {
            text: content.text,
            quick_replies: flat.slice(0, 13).map((b) => ({
              content_type: 'text',
              title: b.label.slice(0, 20),
              payload: b.id.slice(0, 1000),
            })),
          };
        }
        default:
          throw new Error(
            `Unsupported content type for instagram: ${(content as { type: string }).type}`,
          );
      }
    },
  });

  function getAuthUrl(options: {
    appId: string;
    redirectUri: string;
    scopes?: string[];
    state?: string;
  }): string {
    const scopes = (options.scopes ?? DEFAULT_SCOPES).join(',');
    const params = new URLSearchParams({
      client_id: options.appId,
      redirect_uri: options.redirectUri,
      scope: scopes,
      response_type: 'code',
    });
    if (options.state) params.set('state', options.state);
    return `${INSTAGRAM_AUTH_BASE}?${params.toString()}`;
  }

  async function exchangeCode(
    code: string,
    options: { appId: string; appSecret: string; redirectUri: string },
  ): Promise<InstagramTokenResult> {
    const res = await fetch(INSTAGRAM_TOKEN_BASE, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: options.appId,
        client_secret: options.appSecret,
        grant_type: 'authorization_code',
        redirect_uri: options.redirectUri,
        code,
      }).toString(),
    });
    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      error_type?: string;
      error_message?: string;
    };
    if (!data.access_token) {
      throw new Error(`Instagram exchangeCode failed: ${data.error_message ?? JSON.stringify(data)}`);
    }
    return { accessToken: data.access_token, tokenType: data.token_type ?? 'bearer' };
  }

  async function getLongLivedToken(
    shortLivedToken: string,
    appSecret?: string,
  ): Promise<InstagramTokenResult> {
    const secret = appSecret ?? config.appSecret;
    if (!secret) throw new Error('appSecret is required to exchange for a long-lived token');
    const params = new URLSearchParams({
      grant_type: 'ig_exchange_token',
      client_secret: secret,
      access_token: shortLivedToken,
    });
    const res = await fetch(`${graphBase}/access_token?${params.toString()}`);
    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: { message?: string };
    };
    if (!data.access_token) {
      throw new Error(`Instagram getLongLivedToken failed: ${data.error?.message ?? JSON.stringify(data)}`);
    }
    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? 'bearer',
      expiresIn: data.expires_in,
    };
  }

  async function refreshToken(longLivedToken: string): Promise<InstagramTokenResult> {
    const params = new URLSearchParams({
      grant_type: 'ig_refresh_token',
      access_token: longLivedToken,
    });
    const res = await fetch(`${graphBase}/refresh_access_token?${params.toString()}`);
    const data = (await res.json()) as {
      access_token?: string;
      token_type?: string;
      expires_in?: number;
      error?: { message?: string };
    };
    if (!data.access_token) {
      throw new Error(`Instagram refreshToken failed: ${data.error?.message ?? JSON.stringify(data)}`);
    }
    return {
      accessToken: data.access_token,
      tokenType: data.token_type ?? 'bearer',
      expiresIn: data.expires_in,
    };
  }

  return {
    channel: 'instagram',
    capabilities: CAPABILITIES,
    ...base,
    getAuthUrl,
    exchangeCode,
    getLongLivedToken,
    refreshToken,
  };
}

export { createMetaGraphBase } from './meta-base.js';
export type { MetaGraphConfig, MetaGraphBase } from './meta-base.js';
