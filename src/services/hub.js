// Fan-out of live messages to the WebSocket clients watching each server.
const OPEN = 1; // WebSocket.OPEN
export const CLOSE_SESSION_ENDED = 4401;

export function createHub() {
  const socketsOf = new Map(); // serverId -> Set<socket>
  const serverOf = new Map(); // socket -> serverId
  const sessionOf = new Map(); // socket -> opaque session key (may be undefined)

  function unsubscribe(socket) {
    const serverId = serverOf.get(socket);
    if (serverId === undefined) return;
    serverOf.delete(socket);
    sessionOf.delete(socket);
    const sockets = socketsOf.get(serverId);
    sockets.delete(socket);
    if (sockets.size === 0) socketsOf.delete(serverId);
  }

  // `sessionKey` ties the socket to the session that opened it (see closeSessions).
  function subscribe(serverId, socket, sessionKey) {
    unsubscribe(socket);
    serverOf.set(socket, serverId);
    sessionOf.set(socket, sessionKey);
    let sockets = socketsOf.get(serverId);
    if (!sockets) socketsOf.set(serverId, (sockets = new Set()));
    sockets.add(socket);
  }

  // Sends `message` (serialised once, as JSON) to every open socket of the server.
  function publish(serverId, message) {
    const sockets = socketsOf.get(serverId);
    if (!sockets) return;
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState !== OPEN) continue;
      try {
        socket.send(payload);
      } catch {
        // A broken client must not stop delivery to the others; its close event cleans it up.
      }
    }
  }

  const subscribedServerIds = () => [...socketsOf.keys()];

  // Closes (code 4401) and forgets every socket whose session key satisfies
  // `predicate`, so a revoked session cannot keep reading the live stream.
  function closeSessions(predicate) {
    for (const [socket, key] of [...sessionOf]) {
      if (!predicate(key)) continue;
      unsubscribe(socket);
      try {
        socket.close(CLOSE_SESSION_ENDED, 'session_ended');
      } catch {
        // Already closing: nothing left to do.
      }
    }
  }

  return { subscribe, unsubscribe, publish, subscribedServerIds, closeSessions };
}
