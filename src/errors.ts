export class AppError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }
}

export const Errors = {
  notConnected: () =>
    new AppError(409, 'INTEGRATION_NOT_CONNECTED', 'No active Sprintle/Twilio integration'),
  invalidProviderCredentials: () =>
    new AppError(422, 'INVALID_PROVIDER_CREDENTIALS', 'Sprintle/Twilio rejected the credentials'),
  providerUnavailable: (message: string) =>
    new AppError(502, 'PROVIDER_ERROR', `Sprintle/Twilio request failed: ${message}`),
  conversationNotFound: () => new AppError(404, 'CONVERSATION_NOT_FOUND', 'Conversation not found'),
  invalidTransition: (from: string, to: string) =>
    new AppError(409, 'INVALID_STATUS_TRANSITION', `Cannot move a conversation from ${from} to ${to}`),
  sendCancelled: () =>
    new AppError(409, 'SEND_CANCELLED', 'The integration was disconnected while the message was sending'),
  invalidSignature: () => new AppError(401, 'INVALID_SIGNATURE', 'Webhook signature is missing or invalid'),
  eventPublishFailed: () =>
    new AppError(503, 'EVENT_PUBLISH_FAILED', 'Event was recorded but could not be queued; retry later'),
  eventNotFound: () => new AppError(404, 'EVENT_NOT_FOUND', 'Event not found'),
  unauthenticated: () => new AppError(401, 'UNAUTHENTICATED', 'Authentication required'),
};
