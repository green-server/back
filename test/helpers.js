import './env.js';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';
import { createServer } from '../src/app.js';
import { one, pool } from '../src/db.js';

export const ORIGIN = 'http://front.test';
const sockets = new Set();
export const SERVER = { name: 'home', kind: 'home_pc', ratePlan: 'home_tiered', householdKwh: 300 };

export async function resetDb() {
  const row = await one('SELECT DATABASE() AS db');
  assert.match(row?.db ?? '', /^green_server_test(_\w+)?$/, 'tests may only run against a green_server_test database');
  await pool.query('DELETE FROM users');
}

export async function startApp() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  return {
    base: `http://127.0.0.1:${port}`,
    wsBase: `ws://127.0.0.1:${port}`,
    // A failed test leaves its sockets open, and close() would otherwise wait on them forever.
    close: () =>
      new Promise((resolve) => {
        for (const ws of sockets) ws.terminate();
        server.close(resolve);
      }),
  };
}

export class Client {
  cookie = '';
  constructor(base) {
    this.base = base;
  }

  async req(method, path, body, headers = {}) {
    const res = await fetch(this.base + path, {
      method,
      headers: {
        ...(this.cookie ? { cookie: this.cookie } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const setCookie = res.headers.get('set-cookie');
    if (setCookie) this.cookie = setCookie.split(';')[0];
    const text = await res.text();
    return { status: res.status, body: text ? JSON.parse(text) : null, headers: res.headers };
  }
}

let nextEmail = 0;

export async function signup(base, email = `user${++nextEmail}@test.dev`) {
  const client = new Client(base);
  const res = await client.req('POST', '/api/auth/signup', { email, name: '사용자', password: 'password-123' });
  assert.equal(res.status, 201);
  return { client, user: res.body, email };
}

export async function addServer(client, input = SERVER) {
  const res = await client.req('POST', '/api/servers', input);
  assert.equal(res.status, 201);
  return res.body;
}

/** A WebSocket client that keeps what it receives, so a test can wait for one message by shape. */
export class Peer {
  inbox = [];
  waiters = [];

  constructor(ws) {
    this.ws = ws;
    ws.on('message', (data) => {
      this.inbox.push(JSON.parse(data.toString()));
      for (const wake of this.waiters.splice(0)) wake();
    });
  }

  async next(match, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const i = this.inbox.findIndex(match);
      if (i >= 0) return this.inbox.splice(i, 1)[0];
      const left = deadline - Date.now();
      if (left <= 0) assert.fail(`no matching message; inbox: ${JSON.stringify(this.inbox)}`);
      await new Promise((resolve) => {
        const timer = setTimeout(resolve, left);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
  }

  send(message) {
    this.ws.send(JSON.stringify(message));
  }

  async close() {
    if (this.ws.readyState === WebSocket.CLOSED) return;
    await new Promise((resolve) => {
      this.ws.once('close', resolve);
      this.ws.close();
    });
  }
}

export function connect(url, headers) {
  const ws = new WebSocket(url, { headers });
  sockets.add(ws);
  const peer = new Peer(ws);
  return new Promise((resolve, reject) => {
    ws.once('open', () => resolve(peer));
    ws.once('unexpected-response', (_req, res) => reject(new Error(String(res.statusCode))));
    ws.once('error', reject);
  });
}

export const connectAgent = (wsBase, token) =>
  connect(`${wsBase}/ws/agent`, { authorization: `Bearer ${token}` });

export const connectWeb = (wsBase, cookie) =>
  connect(`${wsBase}/ws/web`, { origin: ORIGIN, cookie });

export const metric = (overrides = {}) => ({
  type: 'metrics',
  ts: new Date().toISOString(),
  cpuPct: 12.5,
  memPct: 40,
  watts: 80,
  isEstimated: false,
  processes: [
    { pid: 1, name: 'small', cpuPct: 1, watts: 2 },
    { pid: 2, name: 'big', cpuPct: 50, watts: 30 },
  ],
  ...overrides,
});

export const toolCall = (consultationId, requestId, overrides = {}) => ({
  type: 'tool_call',
  consultationId,
  requestId,
  command: 'systemctl stop minecraft',
  tier: 'approve',
  decision: 'pending',
  undoCommand: 'systemctl start minecraft',
  ...overrides,
});

export async function insertToolCall(consultationId, fields) {
  const row = { consultation_id: consultationId, command: 'cmd', tier: 'approve', decision: 'pending', ...fields };
  const [result] = await pool.query('INSERT INTO tool_calls SET ?', [row]);
  return result.insertId;
}

export async function insertConsultation(serverId) {
  const [result] = await pool.query("INSERT INTO consultations (server_id, auth_mode) VALUES (?, 'api_key')", [serverId]);
  return result.insertId;
}
