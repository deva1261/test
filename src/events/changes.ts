import { EventEmitter } from 'node:events';

/** What changed in board-db, pushed to connected UIs so they refresh without a page reload. */
export type BoardChange =
  | { type: 'conversation.changed'; conversationId: string }
  | { type: 'message.changed'; conversationId: string; messageId: string }
  | { type: 'integration.changed' };

/** Postgres NOTIFY channel. The worker and every API replica write to it; each API replica listens. */
export const CHANGE_CHANNEL = 'board_changes';

export type ChangeListener = (change: BoardChange) => void;

/** In-process fan-out from one change source to every open SSE stream. */
export class ChangeHub {
  private readonly emitter = new EventEmitter();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  emit(change: BoardChange): void {
    this.emitter.emit('change', change);
  }

  subscribe(listener: ChangeListener): () => void {
    this.emitter.on('change', listener);
    return () => this.emitter.off('change', listener);
  }

  get listenerCount(): number {
    return this.emitter.listenerCount('change');
  }
}
