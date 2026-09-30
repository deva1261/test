// @ts-check
import { STREAM_PATH } from './api.js';

/**
 * Board behaviour: loading, live updates, selection, drafts, sending and status changes.
 * Takes its API, store, EventSource and timers as arguments so tests can drive it.
 *
 * @param {{
 *   api: ReturnType<typeof import('./api.js').createApi>,
 *   store: ReturnType<typeof import('./state.js').createStore>,
 *   EventSourceImpl?: typeof EventSource | null,
 *   pollMs?: number,
 *   searchDebounceMs?: number,
 *   refreshDebounceMs?: number,
 * }} deps
 */
export function createController({
  api,
  store,
  EventSourceImpl = typeof EventSource === 'undefined' ? null : EventSource,
  pollMs = 15_000,
  searchDebounceMs = 250,
  refreshDebounceMs = 150,
}) {
  let conversationsRequest = 0;
  /** @type {Record<string, number>} */
  const messageRequests = {};
  /** @type {ReturnType<typeof setTimeout> | null} */
  let searchTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let refreshTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let pollTimer = null;
  /** @type {EventSource | null} */
  let source = null;

  const state = () => store.get();

  async function loadIntegration() {
    try {
      const { integration } = await api.status();
      const previous = state().integration?.status;
      store.update({ integration, integrationError: null });
      // Connecting pulls whatever arrived meanwhile; disconnecting clears the list's "stale" warning.
      if (previous !== undefined && previous !== integration.status && state().conversationsLoaded) {
        void loadConversations({ silent: true });
      }
    } catch (err) {
      store.update({ integrationError: /** @type {Error} */ (err).message });
    }
  }

  /** @param {{ silent?: boolean }} [options] silent keeps the current list on screen while refreshing */
  async function loadConversations(options = {}) {
    const id = ++conversationsRequest;
    store.update({ loadingConversations: true, ...(options.silent ? {} : { conversationsError: null }) });
    try {
      const { conversations, meta } = await api.listConversations(state().filters);
      if (id !== conversationsRequest) return; // a newer search superseded this one
      const known = { ...state().known };
      for (const c of conversations) known[c.id] = c;
      store.update({
        conversations,
        known,
        conversationsLoaded: true,
        loadingConversations: false,
        conversationsError: null,
        stale: Boolean(meta?.stale),
      });
    } catch (err) {
      if (id !== conversationsRequest) return;
      // Keep the last good list on screen; only the banner changes (REQ-008).
      store.update({ loadingConversations: false, conversationsError: /** @type {Error} */ (err).message });
    }
  }

  /** @param {string} conversationId @param {{ silent?: boolean }} [options] */
  async function loadMessages(conversationId, options = {}) {
    const id = (messageRequests[conversationId] = (messageRequests[conversationId] ?? 0) + 1);
    const current = state().messages[conversationId] ?? { items: [], loading: false, loaded: false, error: null };
    patchMessages(conversationId, { ...current, loading: !options.silent || !current.loaded, error: options.silent ? current.error : null });
    try {
      const { messages } = await api.listMessages(conversationId);
      if (id !== messageRequests[conversationId]) return;
      patchMessages(conversationId, { items: messages, loading: false, loaded: true, error: null });
    } catch (err) {
      if (id !== messageRequests[conversationId]) return;
      patchMessages(conversationId, {
        ...(state().messages[conversationId] ?? current),
        loading: false,
        error: /** @type {Error} */ (err).message,
      });
    }
  }

  /** @param {string} conversationId @param {{ items: any[], loading: boolean, loaded: boolean, error: string | null }} value */
  function patchMessages(conversationId, value) {
    store.update((s) => ({ messages: { ...s.messages, [conversationId]: value } }));
  }

  /** @param {string} conversationId */
  function select(conversationId) {
    if (state().selectedId === conversationId) return;
    store.update({ selectedId: conversationId, sendError: null, statusError: null });
    void loadMessages(conversationId);
  }

  /** Switching views never touches the selection (REQ-002). @param {'board' | 'list'} view */
  function setView(view) {
    if (state().view !== view) store.update({ view });
  }

  /** @param {string} q */
  function setSearch(q) {
    store.update((s) => ({ filters: { ...s.filters, q } }));
    if (searchTimer) clearTimeout(searchTimer);
    searchTimer = setTimeout(() => void loadConversations(), searchDebounceMs);
  }

  /** @param {string} status */
  function setStatusFilter(status) {
    store.update((s) => ({ filters: { ...s.filters, status } }));
    void loadConversations();
  }

  function clearFilters() {
    store.update({ filters: { q: '', status: '' } });
    void loadConversations();
  }

  /** Typing updates the draft without re-rendering, so the textarea keeps focus. @param {string} id @param {string} text */
  function updateDraft(id, text) {
    store.update((s) => ({ drafts: { ...s.drafts, [id]: text } }), { silent: true });
  }

  /** On failure the draft is left untouched so the user can retry without retyping. @param {string} conversationId */
  async function send(conversationId) {
    const body = (state().drafts[conversationId] ?? '').trim();
    if (!body || state().sendingId) return;
    store.update({ sendingId: conversationId, sendError: null });
    try {
      const { message } = await api.sendMessage(conversationId, body);
      const current = state().messages[conversationId] ?? { items: [], loading: false, loaded: true, error: null };
      patchMessages(conversationId, {
        ...current,
        items: [...current.items.filter((m) => m.id !== message.id), message],
      });
      store.update((s) => ({ sendingId: null, drafts: { ...s.drafts, [conversationId]: '' } }));
      void loadConversations({ silent: true });
    } catch (err) {
      store.update({ sendingId: null, sendError: { conversationId, message: /** @type {Error} */ (err).message } });
      void loadMessages(conversationId, { silent: true }); // shows the failed/cancelled row
    }
  }

  /** @param {string} conversationId @param {string} status */
  async function changeStatus(conversationId, status) {
    store.update({ statusError: null });
    try {
      const { conversation } = await api.updateStatus(conversationId, status);
      store.update((s) => ({
        known: { ...s.known, [conversation.id]: conversation },
        conversations: s.conversations.map((c) => (c.id === conversation.id ? conversation : c)),
      }));
      void loadConversations({ silent: true });
    } catch (err) {
      store.update({ statusError: /** @type {Error} */ (err).message });
    }
  }

  /** @param {{ accountSid: string, authToken: string }} credentials */
  async function connect(credentials) {
    store.update({ connecting: true, connectError: null });
    try {
      const { integration } = await api.connect(credentials);
      store.update({ integration, integrationError: null, connecting: false });
      void loadConversations();
    } catch (err) {
      store.update({ connecting: false, connectError: /** @type {Error} */ (err).message });
    }
  }

  async function disconnect() {
    try {
      const { integration } = await api.disconnect();
      store.update({ integration, integrationError: null });
    } catch (err) {
      store.update({ integrationError: /** @type {Error} */ (err).message });
    }
  }

  function scheduleRefresh() {
    if (refreshTimer) return;
    refreshTimer = setTimeout(() => {
      refreshTimer = null;
      void loadConversations({ silent: true });
    }, refreshDebounceMs);
  }

  /** Applies a change pushed from board-api's SSE stream. @param {any} change */
  function handleChange(change) {
    if (change?.type === 'integration.changed') {
      void loadIntegration();
    } else if (change?.type === 'conversation.changed') {
      scheduleRefresh();
    } else if (change?.type === 'message.changed') {
      scheduleRefresh();
      if (change.conversationId === state().selectedId) void loadMessages(change.conversationId, { silent: true });
    }
  }

  function startLiveUpdates() {
    if (EventSourceImpl) {
      source = new EventSourceImpl(STREAM_PATH);
      source.addEventListener('ready', () => {
        const reconnected = state().live === 'reconnecting';
        store.update({ live: 'live' });
        if (reconnected) void loadConversations({ silent: true }); // catch up on anything missed
      });
      source.addEventListener('change', (e) => {
        try {
          handleChange(JSON.parse(/** @type {MessageEvent} */ (e).data));
        } catch {
          // ignore malformed events
        }
      });
      source.addEventListener('error', () => {
        if (state().live !== 'reconnecting') store.update({ live: 'reconnecting' });
      });
    } else {
      store.update({ live: 'polling' });
    }
    // Fallback: while the stream is down (or unsupported), poll so new conversations still appear.
    pollTimer = setInterval(() => {
      if (state().live === 'live') return;
      void loadIntegration();
      void loadConversations({ silent: true });
      const selected = state().selectedId;
      if (selected) void loadMessages(selected, { silent: true });
    }, pollMs);
  }

  async function start() {
    startLiveUpdates();
    await Promise.all([loadIntegration(), loadConversations()]);
  }

  function stop() {
    source?.close();
    for (const t of [searchTimer, refreshTimer]) if (t) clearTimeout(t);
    if (pollTimer) clearInterval(pollTimer);
  }

  return {
    start,
    stop,
    loadIntegration,
    loadConversations,
    loadMessages,
    select,
    setView,
    setSearch,
    setStatusFilter,
    clearFilters,
    updateDraft,
    send,
    changeStatus,
    connect,
    disconnect,
    handleChange,
  };
}
