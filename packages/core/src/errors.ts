import type { ChannelName, DeliveryReceipt } from './types.js';

/**
 * All errors thrown by msgly carry the `name: 'MsglyError'` discriminator
 * plus a machine-readable `code`. Detect them with `isMsglyError(err, code?)`.
 *
 * We use a tagged-union pattern instead of class hierarchies so the library
 * has zero classes of its own — the only class is `Error`, which is required
 * by the JS runtime.
 */
export type MsglyErrorCode =
  | 'AdapterNotRegistered'
  | 'UnsupportedFeature'
  | 'InvalidSignature'
  | 'SendFailed'
  | 'AdapterAlreadyRegistered';

export interface MsglyError extends Error {
  name: 'MsglyError';
  code: MsglyErrorCode;
  /** Channel involved, when applicable. */
  channel?: ChannelName;
  /** Feature involved, for UnsupportedFeature. */
  feature?: string;
  /** Receipt returned by an adapter when SendFailed wraps a failed receipt. */
  receipt?: DeliveryReceipt;
  /** Underlying cause for SendFailed, if any. */
  cause?: unknown;
}

export interface MakeErrorOptions {
  channel?: ChannelName;
  feature?: string;
  receipt?: DeliveryReceipt;
  cause?: unknown;
}

export function makeError(
  code: MsglyErrorCode,
  message: string,
  options: MakeErrorOptions = {},
): MsglyError {
  const err = new Error(message) as MsglyError;
  err.name = 'MsglyError';
  err.code = code;
  if (options.channel !== undefined) err.channel = options.channel;
  if (options.feature !== undefined) err.feature = options.feature;
  if (options.receipt !== undefined) err.receipt = options.receipt;
  if (options.cause !== undefined) err.cause = options.cause;
  return err;
}

export function isMsglyError(
  err: unknown,
  code?: MsglyErrorCode,
): err is MsglyError {
  if (!(err instanceof Error)) return false;
  const e = err as MsglyError;
  if (e.name !== 'MsglyError') return false;
  return code === undefined || e.code === code;
}

// ---------- Convenience constructors ----------

export const adapterNotRegistered = (channel: ChannelName): MsglyError =>
  makeError('AdapterNotRegistered', `No adapter registered for channel: ${channel}`, { channel });

export const adapterAlreadyRegistered = (channel: ChannelName): MsglyError =>
  makeError('AdapterAlreadyRegistered', `Adapter for "${channel}" already registered`, { channel });

export const unsupportedFeature = (channel: ChannelName, feature: string): MsglyError =>
  makeError('UnsupportedFeature', `Channel "${channel}" does not support feature: ${feature}`, { channel, feature });

export const invalidSignature = (channel: ChannelName): MsglyError =>
  makeError('InvalidSignature', `Invalid webhook signature for channel: ${channel}`, { channel });

export const sendFailed = (
  channel: ChannelName,
  cause: unknown,
  receipt?: DeliveryReceipt,
): MsglyError =>
  makeError(
    'SendFailed',
    `Failed to send message via ${channel}: ${cause instanceof Error ? cause.message : String(cause)}`,
    { channel, cause, receipt },
  );
