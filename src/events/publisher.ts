export interface QueuedEvent {
  /** Our provider_events row id; the consumer loads the payload from board-db. */
  eventId: string;
  /** Partition key, so events for one conversation are consumed in order. */
  key: string;
}

export interface EventPublisher {
  publish(event: QueuedEvent): Promise<void>;
}
