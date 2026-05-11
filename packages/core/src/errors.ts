import type { ChannelName } from './types.js';

export class MessagingHubError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MessagingHubError';
  }
}

export class AdapterNotRegisteredError extends MessagingHubError {
  constructor(channel: ChannelName) {
    super(`No adapter registered for channel: ${channel}`);
    this.name = 'AdapterNotRegisteredError';
  }
}

export class UnsupportedFeatureError extends MessagingHubError {
  constructor(channel: ChannelName, feature: string) {
    super(`Channel "${channel}" does not support feature: ${feature}`);
    this.name = 'UnsupportedFeatureError';
  }
}

export class InvalidSignatureError extends MessagingHubError {
  constructor(channel: ChannelName) {
    super(`Invalid webhook signature for channel: ${channel}`);
    this.name = 'InvalidSignatureError';
  }
}

export class SendFailedError extends MessagingHubError {
  public readonly sendCause: unknown;

  constructor(channel: ChannelName, sendCause: unknown) {
    super(`Failed to send message via ${channel}: ${String(sendCause)}`);
    this.name = 'SendFailedError';
    this.sendCause = sendCause;
  }
}
