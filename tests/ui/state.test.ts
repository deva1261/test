import { describe, expect, it } from 'vitest';
import {
  conversationPlaceholder,
  groupByStatus,
  initialState,
  integrationIndicator,
  selectedConversation,
} from '../../public/js/state.js';

describe('integrationIndicator (REQ-007)', () => {
  it('shows connected when the integration is active and healthy', () => {
    expect(integrationIndicator({ status: 'connected', health: 'ok', accountSid: 'AC••••1234' }, null)).toMatchObject({
      tone: 'connected',
      label: 'Connected',
    });
  });

  it('shows an error when connected but failing', () => {
    expect(
      integrationIndicator({ status: 'connected', health: 'degraded', lastError: 'HTTP 503' }, null),
    ).toMatchObject({ tone: 'error', label: 'Connection error', detail: 'Sprintle/Twilio: HTTP 503' });
  });

  it('shows disconnected when inactive or never configured', () => {
    expect(integrationIndicator({ status: 'disconnected' }, null)).toMatchObject({ tone: 'disconnected', label: 'Disconnected' });
    expect(integrationIndicator({ status: 'not_configured' }, null)).toMatchObject({ tone: 'disconnected', label: 'Not connected' });
  });

  it('shows an error when the status cannot be fetched', () => {
    expect(integrationIndicator(null, 'Could not reach the board service.')).toMatchObject({ tone: 'error' });
  });
});

describe('conversationPlaceholder (REQ-006, REQ-008)', () => {
  const base = { ...initialState(), conversationsLoaded: true };

  it('shows loading before the first response', () => {
    expect(conversationPlaceholder(initialState())?.kind).toBe('loading');
  });

  it('shows an empty state when there are no conversations', () => {
    expect(conversationPlaceholder(base)?.kind).toBe('no-conversations');
  });

  it('shows a no-results state, not an error, for a search with no matches', () => {
    const p = conversationPlaceholder({ ...base, filters: { q: 'zzz', status: '' } });
    expect(p).toMatchObject({ kind: 'no-results', title: 'No matching conversations' });
    expect(p?.body).toContain('zzz');
  });

  it('shows an error only when nothing could be loaded at all', () => {
    expect(conversationPlaceholder({ ...initialState(), conversationsError: 'down' })?.kind).toBe('error');
    expect(
      conversationPlaceholder({ ...base, conversations: [{ id: 'a' }], conversationsError: 'down' }),
    ).toBeNull();
  });
});

describe('board helpers', () => {
  it('groups conversations into status columns', () => {
    const groups = groupByStatus([
      { id: 'a', status: 'open' },
      { id: 'b', status: 'resolved' },
      { id: 'c', status: 'open' },
    ]);
    expect(Object.fromEntries(Object.entries(groups).map(([k, v]) => [k, v.map((c) => c.id)]))).toEqual({
      open: ['a', 'c'],
      in_progress: [],
      resolved: ['b'],
    });
  });

  it('keeps the selected conversation even when filters hide it', () => {
    const conv = { id: 'CH1', title: 'x', status: 'open' };
    expect(selectedConversation({ ...initialState(), selectedId: 'CH1', conversations: [], known: { CH1: conv } })).toBe(conv);
  });
});
