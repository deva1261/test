export const CONVERSATION_STATUSES = ['open', 'in_progress', 'resolved'] as const;
export type ConversationStatus = (typeof CONVERSATION_STATUSES)[number];

export const MESSAGE_STATUSES = ['received', 'sending', 'sent', 'delivered', 'failed', 'cancelled'] as const;
export type MessageStatus = (typeof MESSAGE_STATUSES)[number];

export type MessageDirection = 'inbound' | 'outbound';

export interface Integration {
  id: string;
  accountSid: string;
  credentialsCiphertext: string;
  status: 'connected' | 'disconnected';
  connectedAt: Date;
  disconnectedAt: Date | null;
  lastSyncAt: Date | null;
  lastError: string | null;
}

export interface Conversation {
  id: string;
  title: string;
  participant: string;
  status: ConversationStatus;
  lastMessagePreview: string | null;
  lastMessageAt: Date | null;
  providerUpdatedAt: Date;
  messagesSyncedAt: Date | null;
  updatedAt: Date;
}

export interface Message {
  id: string;
  conversationId: string;
  providerMessageId: string | null;
  direction: MessageDirection;
  author: string;
  body: string;
  status: MessageStatus;
  createdAt: Date;
  updatedAt: Date;
}

export interface ProviderEventRecord {
  id: string;
  providerEventId: string;
  type: string;
  payload: unknown;
  receivedAt: Date;
  publishedAt: Date | null;
  processedAt: Date | null;
}

/**
 * Board status transitions. Setting the current status again is a no-op, not an error.
 * Resolved conversations can only be reopened, not moved straight back to in-progress.
 */
export const STATUS_TRANSITIONS: Record<ConversationStatus, readonly ConversationStatus[]> = {
  open: ['in_progress', 'resolved'],
  in_progress: ['open', 'resolved'],
  resolved: ['open'],
};
