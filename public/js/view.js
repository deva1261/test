// @ts-check
import {
  STATUSES,
  TRANSITIONS,
  conversationPlaceholder,
  formatTimestamp,
  groupByStatus,
  hasActiveFilters,
  integrationIndicator,
  isConnected,
  messageStatusLabel,
  selectedConversation,
  statusLabel,
} from './state.js';

/**
 * Tiny element builder. Text always goes through textContent, so provider data can never inject markup.
 * @param {string} tag
 * @param {Record<string, any>} [attrs]
 * @param {(Node | string | null | false | undefined)[]} [children]
 */
function h(tag, attrs = {}, children = []) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === null || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') el.addEventListener(key.slice(2), value);
    else if (key === 'className') el.className = value;
    else if (key === 'value') /** @type {HTMLInputElement} */ (el).value = value;
    else el.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    el.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return el;
}

function spinner() {
  return h('span', { className: 'spinner', 'aria-hidden': 'true' });
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderHeader(state, actions) {
  const indicator = integrationIndicator(state.integration, state.integrationError);
  const liveLabel = {
    connecting: 'Connecting to live updates…',
    live: 'Live',
    reconnecting: 'Reconnecting… (refreshing every few seconds)',
    polling: 'Auto-refreshing',
  }[state.live];

  return h('header', { className: 'topbar' }, [
    h('h1', {}, ['Communication Board']),
    h(
      'div',
      {
        className: `status-indicator status--${indicator.tone}`,
        role: 'status',
        'aria-live': 'polite',
        'data-testid': 'integration-status',
        'data-tone': indicator.tone,
      },
      [
        h('span', { className: 'status-dot', 'aria-hidden': 'true' }),
        h('span', { className: 'status-label' }, [indicator.label]),
        indicator.detail ? h('span', { className: 'status-detail' }, [indicator.detail]) : null,
      ],
    ),
    h('span', { className: `live live--${state.live}`, 'data-testid': 'live-indicator' }, [liveLabel]),
    isConnected(state)
      ? h('button', { type: 'button', className: 'btn btn--ghost', onclick: () => actions.disconnect() }, ['Disconnect'])
      : null,
  ]);
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderConnectPanel(state, actions) {
  if (!state.integration || isConnected(state)) return null;
  /** @param {SubmitEvent} e */
  const onsubmit = (e) => {
    e.preventDefault();
    const form = /** @type {HTMLFormElement} */ (e.target);
    const data = new FormData(form);
    actions.connect({ accountSid: String(data.get('accountSid') ?? ''), authToken: String(data.get('authToken') ?? '') });
  };
  return h('section', { className: 'connect-panel', 'aria-labelledby': 'connect-title' }, [
    h('h2', { id: 'connect-title' }, ['Connect Sprintle/Twilio']),
    h('form', { onsubmit, className: 'connect-form' }, [
      h('label', {}, ['Account SID', h('input', { name: 'accountSid', required: true, autocomplete: 'off' })]),
      h('label', {}, ['Auth Token', h('input', { name: 'authToken', type: 'password', required: true, autocomplete: 'off' })]),
      h('button', { type: 'submit', className: 'btn btn--primary', disabled: state.connecting }, [
        state.connecting ? spinner() : null,
        state.connecting ? 'Connecting…' : 'Connect',
      ]),
    ]),
    state.connectError ? h('p', { className: 'form-error', role: 'alert' }, [state.connectError]) : null,
  ]);
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderToolbar(state, actions) {
  return h('div', { className: 'toolbar' }, [
    h('label', { className: 'visually-hidden', for: 'search' }, ['Search conversations']),
    h('input', {
      id: 'search',
      type: 'search',
      placeholder: 'Search by title, participant or message…',
      value: state.filters.q,
      oninput: (/** @type {InputEvent} */ e) => actions.setSearch(/** @type {HTMLInputElement} */ (e.target).value),
    }),
    h('label', { className: 'visually-hidden', for: 'status-filter' }, ['Filter by status']),
    h(
      'select',
      {
        id: 'status-filter',
        onchange: (/** @type {Event} */ e) => actions.setStatusFilter(/** @type {HTMLSelectElement} */ (e.target).value),
      },
      [
        h('option', { value: '', selected: state.filters.status === '' }, ['All statuses']),
        ...STATUSES.map((s) => h('option', { value: s.value, selected: state.filters.status === s.value }, [s.label])),
      ],
    ),
    hasActiveFilters(state.filters)
      ? h('button', { type: 'button', className: 'btn btn--ghost', onclick: () => actions.clearFilters() }, ['Clear'])
      : null,
    h('div', { className: 'view-toggle', role: 'group', 'aria-label': 'View' }, [
      h('button', { type: 'button', 'data-view': 'board', 'aria-pressed': String(state.view === 'board'), onclick: () => actions.setView('board') }, ['Board']),
      h('button', { type: 'button', 'data-view': 'list', 'aria-pressed': String(state.view === 'list'), onclick: () => actions.setView('list') }, ['List']),
    ]),
    state.loadingConversations && state.conversationsLoaded
      ? h('span', { className: 'refreshing', role: 'status' }, [spinner(), 'Refreshing…'])
      : null,
  ]);
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderBanners(state, actions) {
  return [
    state.conversationsError && state.conversationsLoaded
      ? h('div', { className: 'banner banner--error', role: 'alert', 'data-testid': 'error-banner' }, [
          h('span', {}, [`Could not refresh conversations: ${state.conversationsError} Showing the last loaded data.`]),
          h('button', { type: 'button', className: 'btn btn--ghost', onclick: () => actions.loadConversations() }, ['Retry']),
        ])
      : null,
    state.stale
      ? h('div', { className: 'banner banner--warn', role: 'status', 'data-testid': 'stale-banner' }, [
          'Sprintle/Twilio is not responding, so these conversations may be out of date.',
        ])
      : null,
  ];
}

/** @param {any} c @param {import('./state.js').BoardState} state @param {any} actions */
function conversationCard(c, state, actions) {
  const selected = c.id === state.selectedId;
  return h(
    'button',
    {
      type: 'button',
      className: `card${selected ? ' card--selected' : ''}`,
      'data-conversation-id': c.id,
      'aria-pressed': String(selected),
      onclick: () => actions.select(c.id),
    },
    [
      h('span', { className: 'card-title' }, [c.title || 'Untitled conversation']),
      h('span', { className: 'card-participant' }, [c.participant]),
      c.lastMessagePreview ? h('span', { className: 'card-preview' }, [c.lastMessagePreview]) : null,
      c.lastMessageAt ? h('time', { className: 'card-time', datetime: c.lastMessageAt }, [formatTimestamp(c.lastMessageAt)]) : null,
    ],
  );
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderBoard(state, actions) {
  const groups = groupByStatus(state.conversations);
  return h(
    'div',
    { className: 'board', 'data-testid': 'board-view' },
    STATUSES.map((s) =>
      h('section', { className: `column column--${s.value}`, 'aria-label': s.label }, [
        h('h2', { className: 'column-title' }, [s.label, h('span', { className: 'count' }, [String(groups[s.value].length)])]),
        groups[s.value].length
          ? h('div', { className: 'column-cards' }, groups[s.value].map((c) => conversationCard(c, state, actions)))
          : h('p', { className: 'column-empty' }, ['Nothing here']),
      ]),
    ),
  );
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderList(state, actions) {
  return h(
    'ul',
    { className: 'list', 'data-testid': 'list-view' },
    state.conversations.map((c) => {
      const selected = c.id === state.selectedId;
      return h('li', {}, [
        h(
          'button',
          {
            type: 'button',
            className: `row${selected ? ' row--selected' : ''}`,
            'data-conversation-id': c.id,
            'aria-pressed': String(selected),
            onclick: () => actions.select(c.id),
          },
          [
            h('span', { className: 'row-title' }, [c.title || 'Untitled conversation']),
            h('span', { className: 'row-participant' }, [c.participant]),
            h('span', { className: `pill pill--${c.status}` }, [statusLabel(c.status)]),
            h('span', { className: 'row-preview' }, [c.lastMessagePreview ?? '']),
            c.lastMessageAt ? h('time', { className: 'row-time', datetime: c.lastMessageAt }, [formatTimestamp(c.lastMessageAt)]) : null,
          ],
        ),
      ]);
    }),
  );
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderConversations(state, actions) {
  const placeholder = conversationPlaceholder(state);
  let body;
  if (placeholder?.kind === 'loading') {
    body = h('div', { className: 'placeholder placeholder--loading', role: 'status', 'data-testid': 'loading' }, [
      spinner(),
      h('p', {}, [placeholder.title]),
    ]);
  } else if (placeholder) {
    body = h('div', { className: `placeholder placeholder--${placeholder.kind}`, role: placeholder.kind === 'error' ? 'alert' : 'status', 'data-testid': `placeholder-${placeholder.kind}` }, [
      h('h2', {}, [placeholder.title]),
      h('p', {}, [placeholder.body]),
      placeholder.kind === 'no-results'
        ? h('button', { type: 'button', className: 'btn btn--ghost', onclick: () => actions.clearFilters() }, ['Clear filters'])
        : null,
      placeholder.kind === 'error'
        ? h('button', { type: 'button', className: 'btn btn--ghost', onclick: () => actions.loadConversations() }, ['Retry'])
        : null,
    ]);
  } else {
    body = state.view === 'board' ? renderBoard(state, actions) : renderList(state, actions);
  }
  return h('section', { className: 'conversations', 'aria-busy': String(state.loadingConversations), 'aria-label': 'Conversations' }, [body]);
}

/** @param {any} m */
function renderMessage(m) {
  return h('li', { className: `message message--${m.direction} message--${m.status}`, 'data-message-id': m.id }, [
    h('div', { className: 'message-meta' }, [
      h('span', { className: 'message-parties' }, [
        h('span', { className: 'message-sender', 'data-testid': 'sender' }, [m.author]),
        h('span', { 'aria-hidden': 'true' }, [' → ']),
        h('span', { className: 'visually-hidden' }, [' to ']),
        h('span', { className: 'message-recipient', 'data-testid': 'recipient' }, [m.recipient]),
      ]),
      h('time', { className: 'message-time', datetime: m.createdAt, 'data-testid': 'timestamp' }, [formatTimestamp(m.createdAt)]),
      h('span', { className: `message-status message-status--${m.status}`, 'data-testid': 'message-status' }, [messageStatusLabel(m.status)]),
    ]),
    h('p', { className: 'message-body', 'data-testid': 'body' }, [m.body]),
  ]);
}

/** @param {import('./state.js').BoardState} state @param {any} actions */
function renderDetail(state, actions) {
  const c = selectedConversation(state);
  if (!c) {
    return h('aside', { className: 'detail detail--empty', 'aria-label': 'Conversation' }, [
      h('p', {}, ['Select a conversation to see its messages.']),
    ]);
  }
  const thread = state.messages[c.id] ?? { items: [], loading: true, loaded: false, error: null };
  const draft = state.drafts[c.id] ?? '';
  const sending = state.sendingId === c.id;
  const sendError = state.sendError && state.sendError.conversationId === c.id ? state.sendError.message : null;
  const hiddenByFilters = !state.conversations.some((x) => x.id === c.id);
  const connected = isConnected(state);

  let messages;
  if (thread.loading && !thread.loaded) {
    messages = h('div', { className: 'placeholder placeholder--loading', role: 'status', 'data-testid': 'messages-loading' }, [spinner(), h('p', {}, ['Loading messages…'])]);
  } else if (thread.error && !thread.loaded) {
    messages = h('div', { className: 'placeholder placeholder--error', role: 'alert' }, [
      h('p', {}, [`Could not load messages: ${thread.error}`]),
      h('button', { type: 'button', className: 'btn btn--ghost', onclick: () => actions.loadMessages(c.id) }, ['Retry']),
    ]);
  } else if (!thread.items.length) {
    messages = h('div', { className: 'placeholder placeholder--no-messages', role: 'status' }, [h('p', {}, ['No messages in this conversation yet.'])]);
  } else {
    messages = h('ol', { className: 'messages', 'aria-label': 'Messages' }, thread.items.map(renderMessage));
  }

  return h('aside', { className: 'detail', 'aria-label': 'Conversation', 'data-testid': 'detail', 'data-conversation-id': c.id }, [
    h('div', { className: 'detail-header' }, [
      h('div', {}, [h('h2', {}, [c.title || 'Untitled conversation']), h('p', { className: 'detail-participant' }, [c.participant])]),
      h('label', { className: 'status-select' }, [
        h('span', { className: 'visually-hidden' }, ['Conversation status']),
        h(
          'select',
          {
            id: 'conversation-status',
            onchange: (/** @type {Event} */ e) => actions.changeStatus(c.id, /** @type {HTMLSelectElement} */ (e.target).value),
          },
          STATUSES.filter((s) => s.value === c.status || TRANSITIONS[/** @type {keyof typeof TRANSITIONS} */ (c.status)]?.includes(s.value)).map((s) =>
            h('option', { value: s.value, selected: s.value === c.status }, [s.label]),
          ),
        ),
      ]),
    ]),
    hiddenByFilters ? h('p', { className: 'hint' }, ['This conversation is hidden by the current filters.']) : null,
    state.statusError ? h('p', { className: 'form-error', role: 'alert' }, [state.statusError]) : null,
    thread.error && thread.loaded ? h('p', { className: 'form-error', role: 'alert' }, [`Could not refresh messages: ${thread.error}`]) : null,
    messages,
    h(
      'form',
      {
        className: 'composer',
        onsubmit: (/** @type {SubmitEvent} */ e) => {
          e.preventDefault();
          actions.send(c.id);
        },
      },
      [
        h('label', { className: 'visually-hidden', for: 'composer' }, ['Message']),
        h('textarea', {
          id: 'composer',
          rows: 3,
          maxlength: 1600,
          placeholder: connected ? 'Write a reply…' : 'Connect Sprintle/Twilio to reply',
          disabled: !connected,
          oninput: (/** @type {InputEvent} */ e) => actions.updateDraft(c.id, /** @type {HTMLTextAreaElement} */ (e.target).value),
          onkeydown: (/** @type {KeyboardEvent} */ e) => {
            if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
              e.preventDefault();
              actions.send(c.id);
            }
          },
          value: draft,
        }),
        sendError
          ? h('p', { className: 'form-error', role: 'alert', 'data-testid': 'send-error' }, [`Message not sent: ${sendError} Your draft has been kept.`])
          : null,
        h('button', { type: 'submit', className: 'btn btn--primary', disabled: !connected || sending }, [sending ? spinner() : null, sending ? 'Sending…' : 'Send']),
      ],
    ),
  ]);
}

/**
 * Re-renders the whole app. Focus and caret position are restored by element id,
 * so typing in the search box or composer survives a re-render.
 * @param {HTMLElement} root
 * @param {import('./state.js').BoardState} state
 * @param {any} actions
 */
export function render(root, state, actions) {
  const active = /** @type {HTMLInputElement | null} */ (document.activeElement);
  const focusId = active && root.contains(active) ? active.id : '';
  const selection = active && focusId && 'selectionStart' in active ? [active.selectionStart, active.selectionEnd] : null;

  root.replaceChildren(
    renderHeader(state, actions),
    ...[renderConnectPanel(state, actions)].filter((x) => x !== null),
    renderToolbar(state, actions),
    ...renderBanners(state, actions).filter((x) => x !== null),
    h('main', { className: `layout layout--${state.view}` }, [renderConversations(state, actions), renderDetail(state, actions)]),
  );

  if (focusId) {
    const el = /** @type {HTMLInputElement | null} */ (document.getElementById(focusId));
    if (el) {
      el.focus();
      if (selection && typeof el.setSelectionRange === 'function') {
        try {
          el.setSelectionRange(selection[0], selection[1]);
        } catch {
          // some input types do not support selection ranges
        }
      }
    }
  }
}
