// @ts-check
/**
 * The board UI's only way to reach data. Every call is a same-origin request to board-api;
 * the UI never talks to Sprintle/Twilio directly (REQ-009). The page's CSP (connect-src 'self')
 * enforces the same rule in the browser.
 */

export const STREAM_PATH = '/conversations/stream';

export class ApiError extends Error {
  /**
   * @param {number} status
   * @param {string} code
   * @param {string} message
   * @param {unknown} [details]
   */
  constructor(status, code, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Plain-language messages for the error codes a board user can run into. */
const FRIENDLY_MESSAGES = {
  NETWORK_ERROR: 'Could not reach the board service. Check your connection and try again.',
  PROVIDER_ERROR: 'Sprintle/Twilio did not respond. Please try again in a moment.',
  INTEGRATION_NOT_CONNECTED: 'Sprintle/Twilio is not connected. Connect it to send messages.',
  SEND_CANCELLED: 'The integration was disconnected while the message was sending.',
  INVALID_PROVIDER_CREDENTIALS: 'Sprintle/Twilio rejected those credentials. Check the Account SID and Auth Token.',
  CONVERSATION_NOT_FOUND: 'This conversation is no longer available.',
  INVALID_STATUS_TRANSITION: 'That status change is not allowed.',
};

/** @param {{ code?: string, message?: string } | undefined} error @param {number} status */
function friendlyMessage(error, status) {
  const code = error?.code;
  if (code && code in FRIENDLY_MESSAGES) return FRIENDLY_MESSAGES[/** @type {keyof typeof FRIENDLY_MESSAGES} */ (code)];
  if (error?.message) return error.message;
  return status >= 500 ? 'The board service had a problem. Please try again.' : `Request failed (${status}).`;
}

/** @param {typeof fetch} [fetchImpl] */
export function createApi(fetchImpl = (input, init) => globalThis.fetch(input, init)) {
  /**
   * @param {string} method
   * @param {string} path
   * @param {unknown} [body]
   */
  async function request(method, path, body) {
    // Relative paths only: requests can only go to the backend that served the page.
    if (!path.startsWith('/') || path.startsWith('//')) throw new Error(`Refusing non-backend URL: ${path}`);
    /** @type {Response} */
    let res;
    try {
      res = await fetchImpl(path, {
        method,
        credentials: 'same-origin',
        headers: body === undefined ? { accept: 'application/json' } : { accept: 'application/json', 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch {
      throw new ApiError(0, 'NETWORK_ERROR', FRIENDLY_MESSAGES.NETWORK_ERROR);
    }
    if (res.status === 204) return null;
    const data = await res.json().catch(() => null);
    if (!res.ok) {
      const error = data?.error;
      throw new ApiError(res.status, error?.code ?? 'HTTP_ERROR', friendlyMessage(error, res.status), error?.details);
    }
    return data;
  }

  return {
    status: () => request('GET', '/integrations/status'),
    /** @param {{ accountSid: string, authToken: string }} credentials */
    connect: (credentials) => request('POST', '/integrations/connect', credentials),
    disconnect: () => request('POST', '/integrations/disconnect'),
    /** @param {{ q?: string, status?: string }} filters */
    listConversations: (filters) => {
      const params = new URLSearchParams({ limit: '200' });
      if (filters.q) params.set('q', filters.q);
      if (filters.status) params.set('status', filters.status);
      return request('GET', `/conversations?${params}`);
    },
    /** @param {string} id */
    listMessages: (id) => request('GET', `/conversations/${encodeURIComponent(id)}/messages`),
    /** @param {string} id @param {string} body */
    sendMessage: (id, body) => request('POST', `/conversations/${encodeURIComponent(id)}/messages`, { body }),
    /** @param {string} id @param {string} status */
    updateStatus: (id, status) => request('PATCH', `/conversations/${encodeURIComponent(id)}/status`, { status }),
  };
}
