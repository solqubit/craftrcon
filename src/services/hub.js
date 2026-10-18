// Fan-out of live messages to the WebSocket clients watching each server.
const OPEN = 1; // WebSocket.OPEN

export function createHub() {
  const socketsOf = new Map(); // serverId -> Set<socket>
  const serverOf = new Map(); // socket -> serverId

  function unsubscribe(socket) {
    const serverId = serverOf.get(socket);
    if (serverId === undefined) return;
    serverOf.delete(socket);
    const sockets = socketsOf.get(serverId);
    sockets.delete(socket);
    if (sockets.size === 0) socketsOf.delete(serverId);
  }

  function subscribe(serverId, socket) {
    unsubscribe(socket);
    serverOf.set(socket, serverId);
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

  return { subscribe, unsubscribe, publish, subscribedServerIds };
}
