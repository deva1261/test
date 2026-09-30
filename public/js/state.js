// @ts-check
/** Pure board state and derivations. No DOM, no network, so it is unit-testable. */

export const STATUSES = /** @type {const} */ ([
  { value: 'open', label: 'Open' },
  { value: 'in_progress', label: 'In Progress' },
  { value: 'resolved', label: 'Resolved' },
]);

/** Mirrors STATUS_TRANSITIONS in src/domain.ts. */
export const TRANSITIONS = {
  open: ['in_progress', 'resolved'],
  in_progress: ['open', 'resolved'],
  resolved: ['open'],
};

/** @param {string} status */
export function statusLabel(status) {
  return STATUSES.find((s) => s.value === status)?.label ?? status;
}

export function initialState() {
  return {
    /** @type {'board' | 'list'} */
    view: 'board',
    /** Survives view switches and filter changes; only an explicit selection changes it. */
    /** @type {string | null} */
    selectedId: null,
    filters: { q: '', status: '' },

    /** @type {any} */
    integration: null,
    /** @type {string | null} */
    integrationError: null,
    connecting: false,
    /** @type {string | null} */
    connectError: null,

    /** @type {any[]} */
    conversations: [],
    /** Every conversation seen so far, so the selected one stays visible even when filtered out. */
    /** @type {Record<string, any>} */
    known: {},
    conversationsLoaded: false,
    loadingConversations: false,
    /** @type {string | null} */
    conversationsError: null,
    stale: false,

    /** @type {Record<string, { items: any[], loading: boolean, loaded: boolean, error: string | null }>} */
    messages: {},
    /** Unsent composer text per conversation. Kept when a send fails. */
    /** @type {Record<string, string>} */
    drafts: {},
    /** @type {string | null} */
    sendingId: null,
    /** @type {{ conversationId: string, message: string } | null} */
    sendError: null,
    /** @type {string | null} */
    statusError: null,

    /** @type {'connecting' | 'live' | 'reconnecting' | 'polling'} */
    live: 'connecting',
  };
}

/** @typedef {ReturnType<typeof initialState>} BoardState */

/** @param {BoardState} [state] */
export function createStore(state = initialState()) {
  /** @type {Set<(s: BoardState) => void>} */
  const listeners = new Set();
  return {
    get: () => state,
    /**
     * @param {Partial<BoardState> | ((s: BoardState) => Partial<BoardState>)} patch
     * @param {{ silent?: boolean }} [options] silent skips re-rendering (e.g. while typing a draft)
     */
    update(patch, options = {}) {
      const next = typeof patch === 'function' ? patch(state) : patch;
      state = { ...state, ...next };
      if (!options.silent) for (const l of listeners) l(state);
    },
    /** @param {(s: BoardState) => void} listener */
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
}

/** @param {any[]} conversations */
export function groupByStatus(conversations) {
  /** @type {Record<string, any[]>} */
  const groups = { open: [], in_progress: [], resolved: [] };
  for (const c of conversations) (groups[c.status] ??= []).push(c);
  return groups;
}

/** @param {{ q: string, status: string }} filters */
export function hasActiveFilters(filters) {
  return Boolean(filters.q.trim() || filters.status);
}

/**
 * What the connection badge shows (REQ-007).
 * @param {any} integration  GET /integrations/status payload
 * @param {string | null} error  set when the status itself could not be fetched
 * @returns {{ tone: 'connected' | 'disconnected' | 'error' | 'unknown', label: string, detail: string }}
 */
export function integrationIndicator(integration, error) {
  if (error) return { tone: 'error', label: 'Status unavailable', detail: error };
  if (!integration) return { tone: 'unknown', label: 'Checking connection…', detail: '' };
  if (integration.status === 'connected') {
    if (integration.health === 'degraded') {
      return {
        tone: 'error',
        label: 'Connection error',
        detail: integration.lastError ? `Sprintle/Twilio: ${integration.lastError}` : 'Sprintle/Twilio is not responding',
      };
    }
    return { tone: 'connected', label: 'Connected', detail: `Sprintle/Twilio · ${integration.accountSid}` };
  }
  if (integration.status === 'disconnected') {
    return { tone: 'disconnected', label: 'Disconnected', detail: 'Sprintle/Twilio integration is inactive' };
  }
  return { tone: 'disconnected', label: 'Not connected', detail: 'Connect Sprintle/Twilio to load conversations' };
}

/** @param {BoardState} state */
export function isConnected(state) {
  return state.integration?.status === 'connected';
}

/**
 * Which placeholder the conversation area shows, if any (REQ-006, REQ-008).
 * @param {BoardState} state
 * @returns {null | { kind: 'loading' | 'error' | 'no-results' | 'no-conversations', title: string, body: string }}
 */
export function conversationPlaceholder(state) {
  if (!state.conversationsLoaded) {
    if (state.conversationsError) {
      return { kind: 'error', title: 'Could not load conversations', body: state.conversationsError };
    }
    return { kind: 'loading', title: 'Loading conversations…', body: '' };
  }
  if (state.conversations.length > 0) return null;
  if (hasActiveFilters(state.filters)) {
    const q = state.filters.q.trim();
    return {
      kind: 'no-results',
      title: 'No matching conversations',
      body: q
        ? `Nothing matches “${q}”${state.filters.status ? ` in ${statusLabel(state.filters.status)}` : ''}. Try a different search or clear the filters.`
        : `There are no ${statusLabel(state.filters.status)} conversations.`,
    };
  }
  return {
    kind: 'no-conversations',
    title: 'No conversations yet',
    body: isConnected(state)
      ? 'New Sprintle/Twilio conversations will appear here automatically.'
      : 'Connect Sprintle/Twilio to start receiving conversations.',
  };
}

/** @param {BoardState} state */
export function selectedConversation(state) {
  if (!state.selectedId) return null;
  return state.conversations.find((c) => c.id === state.selectedId) ?? state.known[state.selectedId] ?? null;
}

/** @param {string | null | undefined} iso */
export function formatTimestamp(iso) {
  if (!iso) return '';
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' });
}

export const MESSAGE_STATUS_LABELS = {
  received: 'Received',
  sending: 'Sending…',
  sent: 'Sent',
  delivered: 'Delivered',
  failed: 'Failed',
  cancelled: 'Cancelled',
};

/** @param {string} status */
export function messageStatusLabel(status) {
  return MESSAGE_STATUS_LABELS[/** @type {keyof typeof MESSAGE_STATUS_LABELS} */ (status)] ?? status;
}
