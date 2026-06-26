import type {
  Adapter,
  AdapterCapabilities,
  CredentialsCheckResult,
  DeliveryReceipt,
  InboundMessage,
  MediaFile,
  MediaReference,
  MessageContent,
  OutboundMessage,
  WebhookRequest,
} from '@msgly/core';

export interface WeChatConfig {
  /** WeChat Official Account App ID. */
  appId: string;
  /** WeChat Official Account App Secret. */
  appSecret: string;
  /**
   * Verification token set in the WeChat MP console under
   * Development → Basic Configuration → Token. Used for signature verification.
   */
  token: string;
  /** Override for tests. Defaults to https://api.weixin.qq.com. */
  apiBase?: string;
}

export interface WeChatAdapter extends Adapter {
  readonly channel: 'wechat';
  /**
   * Retrieve a valid access token, auto-refreshing when it expires.
   * The token has a 2-hour TTL; the adapter caches it with a 1-minute buffer.
   */
  getAccessToken(): Promise<string>;
}

/**
 * Plain-text formatter for WeChat. WeChat Official Account messages are plain
 * text — these helpers return the text unchanged so code that imports `fmt`
 * from any adapter compiles uniformly.
 */
export const fmt = {
  bold: (t: string) => t,
  italic: (t: string) => t,
  strikethrough: (t: string) => t,
  code: (t: string) => t,
  link: (t: string, url: string) => `${t} (${url})`,
};

const WECHAT_API = 'https://api.weixin.qq.com';

const CAPABILITIES: AdapterCapabilities = {
  text: true,
  media: { image: true, video: true, audio: true, file: false },
  interactive: { buttons: false, quickReplies: true },
  templates: false,
  reactions: false,
  typing: false,
};

function randomId(): string {
  if (typeof globalThis.crypto?.randomUUID === 'function') {
    return globalThis.crypto.randomUUID();
  }
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * Pure-JS synchronous SHA-1 (FIPS 180-4). Used for WeChat's GET challenge
 * verification, which must be synchronous per the Adapter interface contract.
 */
function sha1Sync(str: string): string {
  const bytes = new TextEncoder().encode(str);
  const len = bytes.length;
  const totalLen = Math.ceil((len + 9) / 64) * 64;
  const buf = new Uint8Array(totalLen);
  buf.set(bytes);
  buf[len] = 0x80;
  const dv = new DataView(buf.buffer);
  dv.setUint32(totalLen - 8, Math.floor((len * 8) / 0x100000000), false);
  dv.setUint32(totalLen - 4, (len * 8) >>> 0, false);

  const h: number[] = [0x67452301, 0xefcdab89, 0x98badcfe, 0x10325476, 0xc3d2e1f0];
  const rotl = (v: number, n: number) => ((v << n) | (v >>> (32 - n))) >>> 0;

  for (let blk = 0; blk < totalLen; blk += 64) {
    const W: number[] = new Array<number>(80);
    const bv = new DataView(buf.buffer, blk, 64);
    for (let i = 0; i < 16; i++) W[i] = bv.getUint32(i * 4, false);
    for (let i = 16; i < 80; i++) {
      W[i] = rotl(W[i - 3]! ^ W[i - 8]! ^ W[i - 14]! ^ W[i - 16]!, 1);
    }

    let a = h[0]!, b = h[1]!, c = h[2]!, d = h[3]!, e = h[4]!;
    for (let i = 0; i < 80; i++) {
      let f: number, k: number;
      if (i < 20)      { f = (b & c) | (~b & d);           k = 0x5a827999; }
      else if (i < 40) { f = b ^ c ^ d;                    k = 0x6ed9eba1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8f1bbcdc; }
      else             { f = b ^ c ^ d;                    k = 0xca62c1d6; }
      const t = (rotl(a, 5) + f + e + k + W[i]!) >>> 0;
      e = d; d = c; c = rotl(b, 30); b = a; a = t;
    }
    h[0] = (h[0]! + a) >>> 0;
    h[1] = (h[1]! + b) >>> 0;
    h[2] = (h[2]! + c) >>> 0;
    h[3] = (h[3]! + d) >>> 0;
    h[4] = (h[4]! + e) >>> 0;
  }
  return h.map((v) => v!.toString(16).padStart(8, '0')).join('');
}

function checkWeChatSignature(token: string, timestamp: string, nonce: string, signature: string): boolean {
  const expected = sha1Sync([token, timestamp, nonce].sort().join(''));
  return expected === signature;
}

/** Extract a value from WeChat's CDATA XML format. */
function extractXml(xml: string, tag: string): string {
  const cdata = xml.match(new RegExp(`<${tag}><!\\[CDATA\\[([\\s\\S]*?)\\]\\]><\\/${tag}>`));
  if (cdata) return cdata[1] ?? '';
  const raw = xml.match(new RegExp(`<${tag}>([^<]*)<\\/${tag}>`));
  return raw?.[1] ?? '';
}

export function createWeChatAdapter(config: WeChatConfig): WeChatAdapter {
  const apiBase = config.apiBase ?? WECHAT_API;

  // Access token cache
  let cachedToken = '';
  let tokenExpiry = 0;

  async function getAccessToken(): Promise<string> {
    if (cachedToken && Date.now() < tokenExpiry) return cachedToken;
    const res = await fetch(
      `${apiBase}/cgi-bin/token?grant_type=client_credential&appid=${config.appId}&secret=${config.appSecret}`,
    );
    const data = (await res.json()) as {
      access_token?: string;
      expires_in?: number;
      errcode?: number;
      errmsg?: string;
    };
    if (!data.access_token) {
      throw new Error(`WeChat access token error: ${data.errmsg ?? data.errcode ?? 'unknown'}`);
    }
    cachedToken = data.access_token;
    // Buffer 60 s to avoid using an about-to-expire token
    tokenExpiry = Date.now() + ((data.expires_in ?? 7200) - 60) * 1000;
    return cachedToken;
  }

  async function callCustomerApi(
    toUser: string,
    msgBody: Record<string, unknown>,
  ): Promise<void> {
    const token = await getAccessToken();
    const res = await fetch(`${apiBase}/cgi-bin/message/custom/send?access_token=${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json; charset=utf-8' },
      body: JSON.stringify({ touser: toUser, ...msgBody }),
    });
    const data = (await res.json()) as { errcode?: number; errmsg?: string };
    if (data.errcode && data.errcode !== 0) {
      throw new Error(`WeChat customer API error ${data.errcode}: ${data.errmsg}`);
    }
  }

  async function send(message: OutboundMessage): Promise<DeliveryReceipt> {
    const toUser = message.contact.channelUserId;
    const content = message.content;

    try {
      switch (content.type) {
        case 'text':
          await callCustomerApi(toUser, {
            msgtype: 'text',
            text: { content: content.text },
          });
          break;

        case 'image':
          if (content.mediaRef.kind !== 'platform-id') {
            throw new Error('WeChat image send requires a platform-id (media_id). Upload the image first with adapter.uploadMedia().');
          }
          await callCustomerApi(toUser, {
            msgtype: 'image',
            image: { media_id: content.mediaRef.value },
          });
          break;

        case 'video':
          if (content.mediaRef.kind !== 'platform-id') {
            throw new Error('WeChat video send requires a platform-id. Upload first with adapter.uploadMedia().');
          }
          await callCustomerApi(toUser, {
            msgtype: 'video',
            video: {
              media_id: content.mediaRef.value,
              thumb_media_id: content.mediaRef.value,
              title: content.caption ?? '',
              description: '',
            },
          });
          break;

        case 'audio':
          if (content.mediaRef.kind !== 'platform-id') {
            throw new Error('WeChat voice send requires a platform-id. Upload first with adapter.uploadMedia().');
          }
          await callCustomerApi(toUser, {
            msgtype: 'voice',
            voice: { media_id: content.mediaRef.value },
          });
          break;

        case 'interactive': {
          // Flatten 2D buttons → 1D for msgmenu (max 5 items)
          const flat: import('@msgly/core').InteractiveButton[] = Array.isArray(content.buttons[0])
            ? (content.buttons as import('@msgly/core').InteractiveButton[][]).flat()
            : (content.buttons as import('@msgly/core').InteractiveButton[]);
          await callCustomerApi(toUser, {
            msgtype: 'msgmenu',
            msgmenu: {
              head_content: content.text,
              list: flat.slice(0, 5).map((b) => ({
                id: b.id.slice(0, 200),
                content: b.label.slice(0, 40),
              })),
              tail_content: '',
            },
          });
          break;
        }

        case 'location':
          // WeChat customer service API has no location send type — render as text
          await callCustomerApi(toUser, {
            msgtype: 'text',
            text: {
              content: `📍 ${content.name ? `${content.name}\n` : ''}${content.latitude}, ${content.longitude}${content.address ? `\n${content.address}` : ''}`,
            },
          });
          break;

        default:
          return {
            messageId: message.id,
            status: 'failed',
            timestamp: new Date().toISOString(),
            error: {
              code: 'wechat_unsupported_content',
              message: `WeChat adapter does not support content type: ${(content as { type: string }).type}`,
            },
          };
      }

      return {
        messageId: message.id,
        status: 'sent',
        timestamp: new Date().toISOString(),
      };
    } catch (err) {
      return {
        messageId: message.id,
        status: 'failed',
        timestamp: new Date().toISOString(),
        error: {
          code: 'wechat_send_failed',
          message: err instanceof Error ? err.message : String(err),
        },
      };
    }
  }

  async function handleWebhook(req: WebhookRequest): Promise<InboundMessage[]> {
    const xmlStr = new TextDecoder().decode(req.rawBody);

    const toUser = extractXml(xmlStr, 'ToUserName');
    const fromUser = extractXml(xmlStr, 'FromUserName');
    const createTime = extractXml(xmlStr, 'CreateTime');
    const msgType = extractXml(xmlStr, 'MsgType');
    const msgId = extractXml(xmlStr, 'MsgId');

    const timestamp = createTime
      ? new Date(parseInt(createTime, 10) * 1000).toISOString()
      : new Date().toISOString();

    const base = {
      id: randomId(),
      externalId: msgId || undefined,
      channel: 'wechat' as const,
      direction: 'inbound' as const,
      account: { channel: 'wechat' as const, channelAccountId: toUser },
      contact: { channel: 'wechat' as const, channelUserId: fromUser },
      timestamp,
      raw: xmlStr,
    };

    switch (msgType) {
      case 'text': {
        const text = extractXml(xmlStr, 'Content');
        if (!text) return [];
        return [{ ...base, content: { type: 'text', text } }];
      }

      case 'image': {
        const picUrl = extractXml(xmlStr, 'PicUrl');
        const mediaId = extractXml(xmlStr, 'MediaId');
        return [
          {
            ...base,
            content: {
              type: 'image',
              mediaRef: picUrl
                ? { kind: 'url', value: picUrl }
                : { kind: 'platform-id', value: mediaId },
            },
          },
        ];
      }

      case 'voice': {
        const mediaId = extractXml(xmlStr, 'MediaId');
        return [
          { ...base, content: { type: 'audio', mediaRef: { kind: 'platform-id', value: mediaId } } },
        ];
      }

      case 'video':
      case 'shortvideo': {
        const mediaId = extractXml(xmlStr, 'MediaId');
        return [
          { ...base, content: { type: 'video', mediaRef: { kind: 'platform-id', value: mediaId } } },
        ];
      }

      case 'location': {
        const lat = parseFloat(extractXml(xmlStr, 'Location_X') || '0');
        const lon = parseFloat(extractXml(xmlStr, 'Location_Y') || '0');
        const label = extractXml(xmlStr, 'Label');
        return [
          {
            ...base,
            content: { type: 'location', latitude: lat, longitude: lon, name: label || undefined },
          },
        ];
      }

      case 'link': {
        const title = extractXml(xmlStr, 'Title');
        const url = extractXml(xmlStr, 'Url');
        const desc = extractXml(xmlStr, 'Description');
        const text = [title, desc, url].filter(Boolean).join('\n');
        return [{ ...base, content: { type: 'text', text } }];
      }

      case 'event': {
        const event = extractXml(xmlStr, 'Event').toUpperCase();
        const eventKey = extractXml(xmlStr, 'EventKey');

        // Menu click or custom menu event → interaction
        if ((event === 'CLICK' || event === 'VIEW') && eventKey) {
          return [
            {
              ...base,
              content: { type: 'text', text: eventKey },
              interaction: { id: eventKey, data: eventKey },
            },
          ];
        }

        // subscribe / unsubscribe / scan — no message to emit
        return [];
      }

      default:
        return [];
    }
  }

  async function verifySignature(req: WebhookRequest): Promise<boolean> {
    const sig = req.query['signature'] as string | undefined;
    const timestamp = req.query['timestamp'] as string | undefined;
    const nonce = req.query['nonce'] as string | undefined;
    if (!sig || !timestamp || !nonce) return false;
    return checkWeChatSignature(config.token, timestamp, nonce, sig);
  }

  function verifyWebhookChallenge(query: WebhookRequest['query']): string | null {
    const sig = query['signature'] as string | undefined;
    const timestamp = query['timestamp'] as string | undefined;
    const nonce = query['nonce'] as string | undefined;
    const echostr = query['echostr'] as string | undefined;
    if (!sig || !timestamp || !nonce || !echostr) return null;
    return checkWeChatSignature(config.token, timestamp, nonce, sig) ? echostr : null;
  }

  async function uploadMedia(file: MediaFile): Promise<MediaReference> {
    const token = await getAccessToken();
    const typeMap: Record<string, string> = {
      'image/jpeg': 'image',
      'image/png': 'image',
      'image/gif': 'image',
      'image/bmp': 'image',
      'image/webp': 'image',
      'video/mp4': 'video',
      'video/mpeg': 'video',
      'audio/amr': 'voice',
      'audio/mp3': 'voice',
      'audio/mpeg': 'voice',
    };
    const wxType = typeMap[file.mimeType] ?? 'image';

    const form = new FormData();
    const blob =
      file.data instanceof Uint8Array
        ? new Blob([file.data as BlobPart], { type: file.mimeType })
        : (file.data as Blob);
    form.append('media', blob, file.filename ?? 'upload');

    const res = await fetch(
      `${apiBase}/cgi-bin/media/upload?access_token=${token}&type=${wxType}`,
      { method: 'POST', body: form },
    );
    const data = (await res.json()) as {
      media_id?: string;
      errcode?: number;
      errmsg?: string;
    };
    if (!data.media_id) {
      throw new Error(`WeChat uploadMedia failed: ${data.errmsg ?? data.errcode}`);
    }
    return { kind: 'platform-id', value: data.media_id };
  }

  async function downloadMedia(ref: MediaReference): Promise<MediaFile> {
    if (ref.kind !== 'platform-id') {
      throw new Error('WeChat downloadMedia requires a platform-id ref');
    }
    const token = await getAccessToken();
    const res = await fetch(
      `${apiBase}/cgi-bin/media/get?access_token=${token}&media_id=${ref.value}`,
    );
    if (res.status >= 400) {
      throw new Error(`WeChat downloadMedia failed: ${res.status}`);
    }
    const data = new Uint8Array(await res.arrayBuffer());
    const mimeType = res.headers.get('content-type') ?? 'application/octet-stream';
    return { data, mimeType };
  }

  async function verifyCredentials(): Promise<CredentialsCheckResult> {
    if (!config.appId || !config.appSecret) {
      return {
        ok: false,
        reason: 'unauthorized',
        hint: 'WeChatConfig.appId and appSecret are required. Get them from mp.weixin.qq.com → Development → Basic Configuration.',
      };
    }
    try {
      const token = await getAccessToken();
      return { ok: true, accountInfo: `appId: ${config.appId} (token: ${token.slice(0, 8)}…)` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('40001') || msg.includes('invalid')) {
        return {
          ok: false,
          reason: 'unauthorized',
          hint: `WeChat rejected the credentials: ${msg}. Verify appId and appSecret in mp.weixin.qq.com.`,
        };
      }
      return { ok: false, reason: 'network_error', hint: msg };
    }
  }

  return {
    channel: 'wechat',
    capabilities: CAPABILITIES,
    send,
    handleWebhook,
    verifySignature,
    verifyWebhookChallenge,
    uploadMedia,
    downloadMedia,
    verifyCredentials,
    getAccessToken,
  };
}
