// Live connections. ponytail: in-process maps, so one backend instance; Redis pub/sub if it ever scales out.
import { WebSocket } from 'ws';

export const agents = new Map();
export const webClients = new Map();

export const isOnline = (serverId) => agents.get(serverId)?.readyState === WebSocket.OPEN;

export function sendToAgent(serverId, message) {
  if (!isOnline(serverId)) return false;
  agents.get(serverId).send(JSON.stringify(message));
  return true;
}

export function broadcast(userId, event) {
  const payload = JSON.stringify(event);
  for (const ws of webClients.get(userId) ?? []) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export const closeAgent = (serverId) => agents.get(serverId)?.close(4001, 'server deleted');

export const closeWebClients = (userId, reason = 'account deleted') => {
  for (const ws of webClients.get(userId) ?? []) ws.close(4001, reason);
};
