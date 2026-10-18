// Thin client for the panel's JSON API and its live WebSocket.
import { store } from './store.js';
import { t } from './i18n.js';
import { toast } from './components/Toast.js';

// `status` is the HTTP status (0 when the request never reached the panel),
// `code` the API's `error` field, `body` the parsed error body (if any).
export class ApiError extends Error {
  constructor(status, code, body = null) {
    super(`API ${status}: ${code}`);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
    this.body = body;
  }
}

// The session is gone (expired, revoked, or the password changed elsewhere):
// drop back to the login screen, telling the user why if they were inside.
function sessionEnded() {
  if (store.get().authenticated === true) toast(t('errors.sessionEnded'), { type: 'warn' });
  store.set({ authenticated: false, servers: null });
}

async function readBody(res) {
  if (res.status === 204) return null;
  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  const init = { method, credentials: 'same-origin', headers: { Accept: 'application/json' } };
  if (body !== undefined) {
    init.headers['Content-Type'] = 'application/json';
    init.body = JSON.stringify(body);
  }
  let res;
  try {
    res = await fetch(path, init);
  } catch {
    throw new ApiError(0, 'network_error');
  }
  const data = await readBody(res);
  if (res.ok) return data;
  if (res.status === 401) sessionEnded();
  throw new ApiError(res.status, data?.error ?? `http_${res.status}`, data);
}

const RECONNECT_MS = 3000;
const CLOSE_SESSION_REVOKED = 4401;

// Opens the live stream of a server ({ type: 'console' | 'status', ... }
// messages) and keeps it open, reconnecting every 3 s after a drop. Returns a
// function that closes it for good.
export function openLive(serverId, onMessage) {
  const scheme = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const url = `${scheme}//${location.host}/api/servers/${encodeURIComponent(serverId)}/live`;
  let socket = null;
  let timer = null;
  let closed = false;

  function connect() {
    timer = null;
    socket = new WebSocket(url);
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      onMessage(message);
    };
    socket.onclose = (event) => {
      socket = null;
      if (closed) return;
      if (event.code === CLOSE_SESSION_REVOKED) {
        closed = true;
        sessionEnded();
        return;
      }
      timer = setTimeout(connect, RECONNECT_MS);
    };
  }

  connect();
  return () => {
    closed = true;
    clearTimeout(timer);
    socket?.close();
  };
}
