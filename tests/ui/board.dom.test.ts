// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../public/js/api.js';
import { createController } from '../../public/js/controller.js';
import { createStore } from '../../public/js/state.js';
import { render } from '../../public/js/view.js';

type Conv = { id: string; title: string; participant: string; status: string; lastMessagePreview: string | null; lastMessageAt: string | null };

const conv = (over: Partial<Conv> = {}): Conv => ({
  id: 'CH1',
  title: 'Order #1001 delivery',
  participant: '+15550001111',
  status: 'open',
  lastMessagePreview: 'Where is my order?',
  lastMessageAt: '2026-01-01T09:00:00.000Z',
  ...over,
});

const connected = { status: 'connected', health: 'ok', accountSid: 'AC••••••1234', lastError: null };

/** In-memory board-api double with the same method surface as createApi(). */
function fakeApi() {
  const db = {
    integration: { ...connected } as any,
    conversations: [conv(), conv({ id: 'CH2', title: 'Refund request', participant: '+15550002222', status: 'in_progress', lastMessagePreview: 'Money back please' })],
    messages: {
      CH1: [
        { id: 'm1', conversationId: 'CH1', direction: 'inbound', author: '+15550001111', recipient: 'Agent', body: 'Where is my order?', status: 'received', createdAt: '2026-01-01T09:00:00.000Z' },
        { id: 'm2', conversationId: 'CH1', direction: 'outbound', author: 'Agent', recipient: '+15550001111', body: 'Checking now', status: 'delivered', createdAt: '2026-01-01T09:02:00.000Z' },
      ],
    } as Record<string, any[]>,
    failList: null as ApiError | null,
    failSend: null as ApiError | null,
    hold: null as Promise<void> | null,
  };
  const api = {
    status: vi.fn(async () => ({ integration: db.integration })),
    connect: vi.fn(async () => {
      db.integration = { ...connected };
      return { integration: db.integration };
    }),
    disconnect: vi.fn(async () => {
      db.integration = { status: 'disconnected', health: null };
      return { integration: db.integration, cancelledSends: 0 };
    }),
    listConversations: vi.fn(async ({ q, status }: { q?: string; status?: string }) => {
      if (db.hold) await db.hold;
      if (db.failList) throw db.failList;
      const needle = q?.toLowerCase();
      return {
        conversations: db.conversations.filter(
          (c) =>
            (!status || c.status === status) &&
            (!needle || [c.title, c.participant, c.lastMessagePreview ?? ''].some((f) => f.toLowerCase().includes(needle))),
        ),
        meta: { connected: true, stale: false },
      };
    }),
    listMessages: vi.fn(async (id: string) => ({ messages: db.messages[id] ?? [], meta: {} })),
    sendMessage: vi.fn(async (id: string, body: string) => {
      if (db.failSend) throw db.failSend;
      const message = { id: `m${Date.now()}`, conversationId: id, direction: 'outbound', author: 'Agent', recipient: '+15550001111', body, status: 'sent', createdAt: '2026-01-01T10:00:00.000Z' };
      (db.messages[id] ??= []).push(message);
      return { message };
    }),
    updateStatus: vi.fn(async (id: string, status: string) => {
      const c = db.conversations.find((x) => x.id === id)!;
      c.status = status;
      return { conversation: { ...c } };
    }),
  };
  return { api, db };
}

class FakeEventSource {
  static last: FakeEventSource | null = null;
  listeners: Record<string, ((e: any) => void)[]> = {};
  constructor(readonly url: string) {
    FakeEventSource.last = this;
  }
  addEventListener(type: string, fn: (e: any) => void) {
    (this.listeners[type] ??= []).push(fn);
  }
  emit(type: string, data?: unknown) {
    for (const fn of this.listeners[type] ?? []) fn({ data: JSON.stringify(data ?? {}) });
  }
  close() {}
}

const flush = async () => {
  for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
};

let root: HTMLElement;
let stop: (() => void) | null = null;

async function mount(options: { EventSourceImpl?: any; pollMs?: number; setup?: (db: ReturnType<typeof fakeApi>['db']) => void } = {}) {
  const { api, db } = fakeApi();
  options.setup?.(db);
  const store = createStore();
  const controller = createController({
    api: api as any,
    store,
    EventSourceImpl: options.EventSourceImpl === undefined ? (FakeEventSource as any) : options.EventSourceImpl,
    pollMs: options.pollMs ?? 60_000,
    searchDebounceMs: 0,
    refreshDebounceMs: 0,
  });
  store.subscribe((s) => render(root, s, controller));
  render(root, store.get(), controller);
  const started = controller.start();
  stop = () => controller.stop();
  return { api, db, store, controller, started };
}

const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
const qa = (sel: string) => [...root.querySelectorAll<HTMLElement>(sel)];
const text = (sel: string) => q(sel)?.textContent ?? '';
const click = (el: Element | null) => (el as HTMLElement).click();

beforeEach(() => {
  document.body.innerHTML = '<div id="app"></div>';
  root = document.getElementById('app')!;
  FakeEventSource.last = null;
});
afterEach(() => {
  stop?.();
  stop = null;
});

describe('REQ-002: board view', () => {
  it('renders conversations in Open / In Progress / Resolved columns', async () => {
    const { started } = await mount();
    await started;
    await flush();

    expect(q('[data-testid="board-view"]')).not.toBeNull();
    const columns = qa('.column').map((col) => ({
      name: col.getAttribute('aria-label'),
      cards: [...col.querySelectorAll('[data-conversation-id]')].map((c) => c.getAttribute('data-conversation-id')),
    }));
    expect(columns).toEqual([
      { name: 'Open', cards: ['CH1'] },
      { name: 'In Progress', cards: ['CH2'] },
      { name: 'Resolved', cards: [] },
    ]);
  });

  it('keeps the selected conversation when switching from board to list view and back', async () => {
    const { started } = await mount();
    await started;
    await flush();

    click(q('[data-testid="board-view"] [data-conversation-id="CH2"]'));
    await flush();
    expect(q('[data-testid="detail"]')?.getAttribute('data-conversation-id')).toBe('CH2');

    click(q('[data-view="list"]'));
    await flush();
    expect(q('[data-testid="list-view"]')).not.toBeNull();
    expect(q('[data-testid="list-view"] [data-conversation-id="CH2"]')?.getAttribute('aria-pressed')).toBe('true');
    expect(q('[data-testid="list-view"] [data-conversation-id="CH1"]')?.getAttribute('aria-pressed')).toBe('false');
    expect(q('[data-testid="detail"]')?.getAttribute('data-conversation-id')).toBe('CH2');

    click(q('[data-view="board"]'));
    await flush();
    expect(q('[data-testid="board-view"] [data-conversation-id="CH2"]')?.getAttribute('aria-pressed')).toBe('true');
  });

  it('shows a newly connected conversation without a page refresh (live stream)', async () => {
    const { db, started } = await mount();
    await started;
    await flush();
    FakeEventSource.last!.emit('ready');
    expect(q('[data-conversation-id="CH3"]')).toBeNull();

    db.conversations.push(conv({ id: 'CH3', title: 'Brand new chat', lastMessageAt: '2026-01-01T11:00:00.000Z' }));
    FakeEventSource.last!.emit('change', { type: 'conversation.changed', conversationId: 'CH3' });
    await flush();

    expect(text('[data-conversation-id="CH3"]')).toContain('Brand new chat');
    expect(text('[data-testid="live-indicator"]')).toBe('Live');
  });

  it('falls back to polling when live updates are unavailable', async () => {
    vi.useFakeTimers();
    try {
      const { db, started } = await mount({ EventSourceImpl: null, pollMs: 1000 });
      await vi.runOnlyPendingTimersAsync();
      await started;
      db.conversations.push(conv({ id: 'CH4', title: 'Polled in' }));
      await vi.advanceTimersByTimeAsync(1000);
      expect(text('[data-conversation-id="CH4"]')).toContain('Polled in');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('REQ-007: connection status indicator', () => {
  it('shows Connected when the integration is active', async () => {
    const { started } = await mount();
    await started;
    const badge = q('[data-testid="integration-status"]')!;
    expect(badge.getAttribute('data-tone')).toBe('connected');
    expect(badge.textContent).toContain('Connected');
    expect(badge.getAttribute('role')).toBe('status');
  });

  it('shows Disconnected after disconnecting, and the connect form', async () => {
    const { started } = await mount();
    await started;
    click(qa('button').find((b) => b.textContent === 'Disconnect')!);
    await flush();
    expect(q('[data-testid="integration-status"]')?.getAttribute('data-tone')).toBe('disconnected');
    expect(text('[data-testid="integration-status"]')).toContain('Disconnected');
    expect(q('.connect-panel')).not.toBeNull();
  });

  it('shows an error state when the integration is failing, updated live', async () => {
    const { db, started } = await mount();
    await started;
    db.integration = { status: 'connected', health: 'degraded', accountSid: 'AC••••••1234', lastError: 'HTTP 503' };
    FakeEventSource.last!.emit('change', { type: 'integration.changed' });
    await flush();
    const badge = q('[data-testid="integration-status"]')!;
    expect(badge.getAttribute('data-tone')).toBe('error');
    expect(badge.textContent).toContain('Connection error');
    expect(badge.textContent).toContain('HTTP 503');
  });
});

describe('REQ-006: search and filters', () => {
  it('returns relevant conversations for a search and a status filter', async () => {
    const { started } = await mount();
    await started;
    const search = q<HTMLInputElement>('#search')!;
    search.value = 'refund';
    search.dispatchEvent(new Event('input'));
    await flush();
    expect(qa('[data-conversation-id]').map((c) => c.dataset.conversationId)).toEqual(['CH2']);

    search.value = '';
    search.dispatchEvent(new Event('input'));
    const filter = q<HTMLSelectElement>('#status-filter')!;
    filter.value = 'open';
    filter.dispatchEvent(new Event('change'));
    await flush();
    expect(qa('[data-conversation-id]').map((c) => c.dataset.conversationId)).toEqual(['CH1']);
  });

  it('shows an empty state, not an error, when nothing matches', async () => {
    const { started } = await mount();
    await started;
    const search = q<HTMLInputElement>('#search')!;
    search.value = 'no-such-customer';
    search.dispatchEvent(new Event('input'));
    await flush();

    expect(q('[data-testid="placeholder-no-results"]')?.textContent).toContain('No matching conversations');
    expect(q('[data-testid="placeholder-no-results"]')?.textContent).toContain('no-such-customer');
    expect(q('[data-testid="error-banner"]')).toBeNull();
    expect(q('[role="alert"]')).toBeNull();

    click(qa('button').find((b) => b.textContent === 'Clear filters')!);
    await flush();
    expect(qa('[data-conversation-id]')).toHaveLength(2);
  });
});

describe('REQ-008: loading, empty and error states', () => {
  it('shows a loading indicator while conversations are being fetched', async () => {
    let release!: () => void;
    const { started } = await mount({ setup: (db) => (db.hold = new Promise<void>((r) => (release = r))) });
    await flush();
    expect(q('[data-testid="loading"]')?.textContent).toContain('Loading conversations');
    expect(q('.conversations')?.getAttribute('aria-busy')).toBe('true');

    release();
    await started;
    await flush();
    expect(q('[data-testid="loading"]')).toBeNull();
    expect(q('.conversations')?.getAttribute('aria-busy')).toBe('false');
  });

  it('shows an empty state when there are no conversations', async () => {
    const { started } = await mount({ setup: (db) => (db.conversations = []) });
    await started;
    await flush();
    expect(text('[data-testid="placeholder-no-conversations"]')).toContain('No conversations yet');
  });

  it('shows a clear error on API failure without breaking the board', async () => {
    const { db, controller, started } = await mount();
    await started;
    await flush();
    db.failList = new ApiError(502, 'PROVIDER_ERROR', 'Sprintle/Twilio did not respond. Please try again in a moment.');
    await controller.loadConversations();
    await flush();

    expect(text('[data-testid="error-banner"]')).toContain('Sprintle/Twilio did not respond');
    expect(q('[data-testid="error-banner"]')?.getAttribute('role')).toBe('alert');
    // The board is still there with the last good data, and still usable.
    expect(qa('[data-testid="board-view"] [data-conversation-id]')).toHaveLength(2);
    click(q('[data-conversation-id="CH1"]'));
    await flush();
    expect(q('[data-testid="detail"]')).not.toBeNull();

    db.failList = null;
    click(qa('[data-testid="error-banner"] button')[0]);
    await flush();
    expect(q('[data-testid="error-banner"]')).toBeNull();
  });

  it('shows an error with a retry when the very first load fails', async () => {
    const { started } = await mount({ setup: (db) => (db.failList = new ApiError(0, 'NETWORK_ERROR', 'Could not reach the board service.')) });
    await started;
    await flush();
    expect(text('[data-testid="placeholder-error"]')).toContain('Could not reach the board service.');
  });
});

describe('REQ-003: message details', () => {
  it('shows sender, receiver, content, timestamp and status for each message', async () => {
    const { started } = await mount();
    await started;
    await flush();
    click(q('[data-conversation-id="CH1"]'));
    await flush();

    const messages = qa('[data-message-id]').map((m) => ({
      sender: m.querySelector('[data-testid="sender"]')?.textContent,
      recipient: m.querySelector('[data-testid="recipient"]')?.textContent,
      body: m.querySelector('[data-testid="body"]')?.textContent,
      datetime: m.querySelector('[data-testid="timestamp"]')?.getAttribute('datetime'),
      hasTime: Boolean(m.querySelector('[data-testid="timestamp"]')?.textContent),
      status: m.querySelector('[data-testid="message-status"]')?.textContent,
    }));
    expect(messages).toEqual([
      { sender: '+15550001111', recipient: 'Agent', body: 'Where is my order?', datetime: '2026-01-01T09:00:00.000Z', hasTime: true, status: 'Received' },
      { sender: 'Agent', recipient: '+15550001111', body: 'Checking now', datetime: '2026-01-01T09:02:00.000Z', hasTime: true, status: 'Delivered' },
    ]);
  });
});

describe('sending messages', () => {
  async function openComposer() {
    const ctx = await mount();
    await ctx.started;
    await flush();
    click(q('[data-conversation-id="CH1"]'));
    await flush();
    const type = (value: string) => {
      const box = q<HTMLTextAreaElement>('#composer')!;
      box.value = value;
      box.dispatchEvent(new Event('input'));
    };
    const submit = async () => {
      q<HTMLFormElement>('.composer')!.dispatchEvent(new Event('submit', { cancelable: true }));
      await flush();
    };
    return { ...ctx, type, submit };
  }

  it('keeps the draft and explains the failure when a send fails', async () => {
    const { db, type, submit } = await openComposer();
    db.failSend = new ApiError(502, 'PROVIDER_ERROR', 'Sprintle/Twilio did not respond. Please try again in a moment.');
    type('Your parcel ships today');
    await submit();

    expect(q<HTMLTextAreaElement>('#composer')!.value).toBe('Your parcel ships today');
    expect(text('[data-testid="send-error"]')).toContain('Your draft has been kept');

    db.failSend = null;
    await submit();
    expect(q<HTMLTextAreaElement>('#composer')!.value).toBe('');
    expect(q('[data-testid="send-error"]')).toBeNull();
    expect(qa('[data-message-id]').at(-1)?.textContent).toContain('Your parcel ships today');
  });

  it('keeps separate drafts per conversation across selection and view changes', async () => {
    const { type } = await openComposer();
    type('draft for CH1');
    click(q('[data-conversation-id="CH2"]'));
    await flush();
    expect(q<HTMLTextAreaElement>('#composer')!.value).toBe('');
    click(q('[data-view="list"]'));
    click(q('[data-conversation-id="CH1"]'));
    await flush();
    expect(q<HTMLTextAreaElement>('#composer')!.value).toBe('draft for CH1');
  });

  it('changes status from the detail panel and moves the card to the new column', async () => {
    await openComposer();
    const select = q<HTMLSelectElement>('#conversation-status')!;
    select.value = 'resolved';
    select.dispatchEvent(new Event('change'));
    await flush();
    expect(q('.column[aria-label="Resolved"] [data-conversation-id="CH1"]')).not.toBeNull();
  });
});

describe('connection changes', () => {
  it('reloads the list when the integration disconnects, clearing the stale warning', async () => {
    const { api, db, store, started } = await mount();
    await started;
    await flush();
    store.update({ stale: true });
    const calls = api.listConversations.mock.calls.length;
    db.integration = { status: 'disconnected', health: null };
    FakeEventSource.last!.emit('change', { type: 'integration.changed' });
    await flush();
    expect(api.listConversations.mock.calls.length).toBe(calls + 1);
    expect(q('[data-testid="stale-banner"]')).toBeNull();
  });
});
