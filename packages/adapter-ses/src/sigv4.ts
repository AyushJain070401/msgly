/**
 * Minimal AWS Signature Version 4 signing, built on Web Crypto so the adapter
 * still runs on Edge runtimes. Only what SES needs — no STS, no session
 * negotiation beyond passing a session token through.
 */

export interface AwsCredentials {
  accessKeyId: string;
  secretAccessKey: string;
  /** Required when using temporary STS credentials. */
  sessionToken?: string;
}

const encoder = new TextEncoder();

function toHex(buffer: ArrayBuffer | Uint8Array): string {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function sha256Hex(input: string | Uint8Array): Promise<string> {
  const data = typeof input === 'string' ? encoder.encode(input) : input;
  return toHex(await globalThis.crypto.subtle.digest('SHA-256', data as BufferSource));
}

async function hmac(key: Uint8Array, message: string): Promise<Uint8Array> {
  const cryptoKey = await globalThis.crypto.subtle.importKey(
    'raw',
    key as BufferSource,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign'],
  );
  const sig = await globalThis.crypto.subtle.sign('HMAC', cryptoKey, encoder.encode(message));
  return new Uint8Array(sig);
}

/**
 * `kSigning = HMAC(HMAC(HMAC(HMAC("AWS4"+secret, date), region), service), "aws4_request")`
 *
 * The chain is what scopes a signature to one day, one region and one service,
 * so a leaked signature cannot be replayed elsewhere.
 */
async function signingKey(
  secret: string,
  date: string,
  region: string,
  service: string,
): Promise<Uint8Array> {
  const kDate = await hmac(encoder.encode(`AWS4${secret}`), date);
  const kRegion = await hmac(kDate, region);
  const kService = await hmac(kRegion, service);
  return hmac(kService, 'aws4_request');
}

/** `20260815T143000Z` and `20260815`, the two formats SigV4 wants. */
export function formatAmzDate(now: Date): { amzDate: string; dateStamp: string } {
  const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { amzDate, dateStamp: amzDate.slice(0, 8) };
}

export interface SignedRequest {
  headers: Record<string, string>;
}

/**
 * Sign a request and return the headers to send.
 *
 * `host` must match the host actually connected to — it is part of the signed
 * canonical request, so a mismatch produces a signature AWS will reject.
 */
export async function signRequest(opts: {
  method: string;
  host: string;
  path: string;
  /** Already URL-encoded, without the leading `?`. */
  query?: string;
  body: string;
  region: string;
  service: string;
  credentials: AwsCredentials;
  /** Injectable for deterministic tests. */
  now?: Date;
  extraHeaders?: Record<string, string>;
}): Promise<SignedRequest> {
  const { amzDate, dateStamp } = formatAmzDate(opts.now ?? new Date());
  const payloadHash = await sha256Hex(opts.body);

  const headers: Record<string, string> = {
    host: opts.host,
    'x-amz-date': amzDate,
    'x-amz-content-sha256': payloadHash,
    ...(opts.credentials.sessionToken
      ? { 'x-amz-security-token': opts.credentials.sessionToken }
      : {}),
    ...(opts.extraHeaders ?? {}),
  };

  // Canonical headers are lowercase, trimmed, and sorted by name.
  const sortedNames = Object.keys(headers)
    .map((h) => h.toLowerCase())
    .sort();
  const lowerHeaders: Record<string, string> = {};
  for (const [k, v] of Object.entries(headers)) {
    lowerHeaders[k.toLowerCase()] = v.trim().replace(/\s+/g, ' ');
  }
  const canonicalHeaders = sortedNames.map((n) => `${n}:${lowerHeaders[n]}\n`).join('');
  const signedHeaders = sortedNames.join(';');

  const canonicalRequest = [
    opts.method,
    opts.path,
    opts.query ?? '',
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${dateStamp}/${opts.region}/${opts.service}/aws4_request`;
  const stringToSign = [
    'AWS4-HMAC-SHA256',
    amzDate,
    scope,
    await sha256Hex(canonicalRequest),
  ].join('\n');

  const key = await signingKey(
    opts.credentials.secretAccessKey,
    dateStamp,
    opts.region,
    opts.service,
  );
  const signature = toHex(await hmac(key, stringToSign));

  return {
    headers: {
      ...headers,
      authorization:
        `AWS4-HMAC-SHA256 Credential=${opts.credentials.accessKeyId}/${scope}, ` +
        `SignedHeaders=${signedHeaders}, Signature=${signature}`,
    },
  };
}
