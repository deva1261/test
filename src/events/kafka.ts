import { Kafka, logLevel, Partitioners, type Consumer, type Producer } from 'kafkajs';
import { z } from 'zod';
import type { EventPublisher, QueuedEvent } from './publisher';

export interface KafkaSettings {
  brokers: string[];
  clientId: string;
  topic: string;
  groupId: string;
}

export function createKafka(settings: KafkaSettings): Kafka {
  return new Kafka({ clientId: settings.clientId, brokers: settings.brokers, logLevel: logLevel.WARN });
}

export class KafkaEventPublisher implements EventPublisher {
  private readonly producer: Producer;
  private connected: Promise<void> | null = null;

  constructor(
    kafka: Kafka,
    private readonly topic: string,
  ) {
    this.producer = kafka.producer({
      idempotent: true,
      maxInFlightRequests: 1,
      createPartitioner: Partitioners.DefaultPartitioner,
    });
  }

  async publish(event: QueuedEvent): Promise<void> {
    this.connected ??= this.producer.connect().catch((err) => {
      this.connected = null;
      throw err;
    });
    await this.connected;
    await this.producer.send({
      topic: this.topic,
      acks: -1,
      messages: [{ key: event.key, value: JSON.stringify({ eventId: event.eventId }) }],
    });
  }

  async disconnect(): Promise<void> {
    if (this.connected) await this.producer.disconnect();
  }
}

const queuedMessageSchema = z.object({ eventId: z.string().min(1) });

/**
 * Consumes the conversation-events topic. The offset is committed only after `handle`
 * resolves, so a crash mid-apply redelivers; processOnce makes the redelivery a no-op.
 */
export async function runConsumer(
  kafka: Kafka,
  settings: KafkaSettings,
  handle: (eventId: string) => Promise<void>,
): Promise<Consumer> {
  const consumer = kafka.consumer({ groupId: settings.groupId });
  await consumer.connect();
  await consumer.subscribe({ topic: settings.topic, fromBeginning: false });
  await consumer.run({
    eachMessage: async ({ message, partition }) => {
      const parsed = queuedMessageSchema.safeParse(safeJson(message.value?.toString()));
      if (!parsed.success) {
        // A poison message would block the partition forever; log and skip it.
        console.error(`Skipping malformed message at partition ${partition} offset ${message.offset}`);
        return;
      }
      await handle(parsed.data.eventId);
    },
  });
  return consumer;
}

function safeJson(raw: string | undefined): unknown {
  try {
    return raw === undefined ? undefined : JSON.parse(raw);
  } catch {
    return undefined;
  }
}
