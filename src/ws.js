import { STATUS_CODES } from 'node:http';
import { WebSocket, WebSocketServer } from 'ws';
import { handleAgentMessage } from './agent.js';
import { sha256, userFromCookie } from './auth.js';
import { config } from './config.js';
import { one } from './db.js';
import { clientIp } from './geo.js';
import { agents, broadcast, webClients } from './hub.js';

const HEARTBEAT_MS = 30_000;
const alive = new WeakSet();

function watch(ws) {
  alive.add(ws);
  ws.on('pong', () => alive.add(ws));
  ws.on('error', (err) => console.error('websocket error', err.message));
}

function acceptAgent(ws, ctx) {
  const { serverId, userId } = ctx;
  const previous = agents.get(serverId);
  agents.set(serverId, ws);
  previous?.close(4000, 'replaced by a newer connection');
  watch(ws);
  broadcast(userId, { type: 'agent_status', serverId, online: true });

  // In order: a tool_result must not overtake the tool_call it answers.
  let queue = Promise.resolve();
  ws.on('message', (data) => {
    queue = queue.then(() => handleAgentMessage(ctx, data.toString())).catch(console.error);
  });
  ws.on('close', () => {
    if (agents.get(serverId) !== ws) return;
    agents.delete(serverId);
    broadcast(userId, { type: 'agent_status', serverId, online: false });
  });
}

function acceptWeb(ws, userId) {
  const clients = webClients.get(userId) ?? new Set();
  webClients.set(userId, clients.add(ws));
  watch(ws);
  ws.on('close', () => {
    clients.delete(ws);
    if (clients.size === 0 && webClients.get(userId) === clients) webClients.delete(userId);
  });
}

function reject(socket, status) {
  socket.end(`HTTP/1.1 ${status} ${STATUS_CODES[status]}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

export function attachWebSockets(server) {
  const agentWss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const webWss = new WebSocketServer({ noServer: true, maxPayload: 1024 });

  async function upgrade(req, socket, head) {
    const { pathname } = new URL(req.url ?? '/', 'http://localhost');
    if (pathname === '/ws/agent') {
      const token = /^Bearer (\S+)$/.exec(req.headers.authorization ?? '')?.[1];
      const row = token
        ? await one('SELECT id, user_id FROM servers WHERE agent_token_hash = ?', [sha256(token)])
        : undefined;
      if (!row) return reject(socket, 401);
      agentWss.handleUpgrade(req, socket, head, (ws) => acceptAgent(ws, { serverId: row.id, userId: row.user_id, ip: clientIp(req) }));
    } else if (pathname === '/ws/web') {
      if (req.headers.origin !== config.frontOrigin) return reject(socket, 403);
      const user = await userFromCookie(req.headers.cookie);
      if (!user) return reject(socket, 401);
      webWss.handleUpgrade(req, socket, head, (ws) => acceptWeb(ws, user.id));
    } else {
      reject(socket, 404);
    }
  }

  server.on('upgrade', (req, socket, head) => {
    socket.on('error', () => {}); // an abort during auth must not take the process down
    upgrade(req, socket, head).catch((err) => {
      console.error(err);
      reject(socket, 500);
    });
  });

  const heartbeat = setInterval(() => {
    for (const ws of [...agentWss.clients, ...webWss.clients]) {
      if (!alive.delete(ws)) ws.terminate();
      else ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();
  server.on('close', () => clearInterval(heartbeat));
}
