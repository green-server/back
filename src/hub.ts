// Live connections. ponytail: in-process maps, so one backend instance; Redis pub/sub if it ever scales out.
import { WebSocket } from 'ws';

export const agents = new Map<number, WebSocket>();
export const webClients = new Map<number, Set<WebSocket>>();

export const isOnline = (serverId: number) => agents.get(serverId)?.readyState === WebSocket.OPEN;

export function sendToAgent(serverId: number, message: object): boolean {
  if (!isOnline(serverId)) return false;
  agents.get(serverId)!.send(JSON.stringify(message));
  return true;
}

export function broadcast(userId: number, event: object): void {
  const payload = JSON.stringify(event);
  for (const ws of webClients.get(userId) ?? []) {
    if (ws.readyState === WebSocket.OPEN) ws.send(payload);
  }
}

export const closeAgent = (serverId: number) => agents.get(serverId)?.close(4001, 'server deleted');

export const closeWebClients = (userId: number) => {
  for (const ws of webClients.get(userId) ?? []) ws.close(4001, 'account deleted');
};
