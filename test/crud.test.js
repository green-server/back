// Full CRUD through the real HTTP API, with every write checked against the rows it left in MySQL.
import { addServer, Client, connectAgent, insertConsultation, insertToolCall, metric, resetDb, SERVER, signup, startApp, toolCall } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { one, pool, rows } from '../src/db.js';
import { runRules } from '../src/jobs.js';

let app;

before(async () => {
  await resetDb();
  app = await startApp();
});
beforeEach(resetDb);
after(async () => {
  await app.close();
  await pool.end();
});

const HOUR = 3_600_000;
const PASSWORD = 'password-123';
const CLOUD = { name: 'vm', kind: 'cloud_vm', ratePlan: 'cloud_hourly', hourlyKrw: 120.5 };

async function waitFor(find) {
  for (let i = 0; i < 150; i++) {
    const found = await find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition never held');
}

const userRow = (id) => one('SELECT * FROM users WHERE id = ?', [id]);
const serverRow = (id) => one('SELECT * FROM servers WHERE id = ?', [id]);
const recRow = (id) => one('SELECT * FROM recommendations WHERE id = ?', [id]);
const callRow = (id) => one('SELECT * FROM tool_calls WHERE id = ?', [id]);
const consultationRow = (id) => one('SELECT * FROM consultations WHERE id = ?', [id]);

async function insertRec(serverId, fields = {}) {
  const row = { server_id: serverId, source: 'rule', type: 'idle', detail: '서버를 끕니다.', est_saving_krw: 500, ...fields };
  const [result] = await pool.query('INSERT INTO recommendations SET ?', [row]);
  return result.insertId;
}

/** An owner with one server and its agent connected. */
async function online(input = SERVER) {
  const { client, user } = await signup(app.base);
  const { server, agentToken } = await addServer(client, input);
  const agent = await connectAgent(app.wsBase, agentToken);
  return { client, user, server, agent };
}

/** Starts a consultation over HTTP and returns its id once the agent has heard about it. */
async function startConsultation(client, agent, serverId, body = { authMode: 'api_key' }) {
  const res = await client.req('POST', `/api/servers/${serverId}/consultations`, body);
  assert.equal(res.status, 201);
  await agent.next((m) => m.type === 'consultation_start' && m.consultationId === res.body.id);
  return res.body;
}

/** The agent reports a call; resolves to its stored row. */
async function reportCall(agent, consultationId, requestId, overrides) {
  agent.send(toolCall(consultationId, requestId, overrides));
  return waitFor(() => one('SELECT * FROM tool_calls WHERE consultation_id = ? AND request_id = ?', [consultationId, requestId]));
}

// ---------------------------------------------------------------- users

test('users: signup inserts one row with a bcrypt hash, a trimmed name and a lowercased email', async () => {
  const c = new Client(app.base);
  const res = await c.req('POST', '/api/auth/signup', { email: ' Mixed@Case.Dev ', name: '  홍길동 ', password: PASSWORD });
  assert.equal(res.status, 201);
  const row = await userRow(res.body.id);
  assert.equal(row.email, 'mixed@case.dev');
  assert.equal(row.name, '홍길동');
  assert.match(row.password_hash, /^\$2b\$10\$/);
  assert.notEqual(row.password_hash, PASSWORD);
  assert.equal((await rows('SELECT id FROM users')).length, 1);
  assert.equal((await c.req('GET', '/api/me')).body.id, res.body.id);
});

test('users: password length bounds are inclusive at 8 and 128', async () => {
  for (const password of ['x'.repeat(8), 'y'.repeat(128)]) {
    const res = await new Client(app.base).req('POST', '/api/auth/signup', { email: `p${password.length}@test.dev`, name: 'n', password });
    assert.equal(res.status, 201, String(password.length));
  }
  for (const password of ['x'.repeat(7), 'x'.repeat(129)]) {
    assert.equal((await new Client(app.base).req('POST', '/api/auth/signup', { email: 'z@test.dev', name: 'n', password })).status, 400);
  }
  assert.equal((await rows('SELECT id FROM users')).length, 2);
});

test('users: invalid signup bodies are refused and write nothing', async () => {
  const c = new Client(app.base);
  const good = { email: 'a@test.dev', name: 'n', password: PASSWORD };
  const bad = [
    [],
    { ...good, email: undefined },
    { ...good, email: 'a@b' },
    { ...good, email: 'two words@test.dev' },
    { ...good, email: `${'x'.repeat(250)}@test.dev` },
    { ...good, name: '   ' },
    { ...good, name: 7 },
    { ...good, password: 12345678 },
    { ...good, password: undefined },
  ];
  for (const body of bad) {
    const res = await c.req('POST', '/api/auth/signup', body);
    assert.equal(res.status, 400, JSON.stringify(body));
    assert.equal(res.body.error.code, 'validation_error');
  }
  assert.equal(c.cookie, '', 'no session for a refused signup');
  assert.deepEqual(await rows('SELECT id FROM users'), []);
});

test('users: a duplicate email is 409 and leaves the first account untouched', async () => {
  const { user } = await signup(app.base, 'same@test.dev');
  const before = await userRow(user.id);
  const dup = new Client(app.base);
  const res = await dup.req('POST', '/api/auth/signup', { email: ' SAME@test.dev', name: '다른 사람', password: 'other-password' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'email_taken');
  assert.equal(dup.cookie, '');
  assert.deepEqual(await userRow(user.id), before);
  assert.equal((await rows('SELECT id FROM users')).length, 1);
});

test('users: login matches the email case-insensitively and returns the account', async () => {
  const { user } = await signup(app.base, 'login@test.dev');
  const c = new Client(app.base);
  const res = await c.req('POST', '/api/auth/login', { email: '  LOGIN@Test.dev ', password: PASSWORD });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, user);
  assert.match(c.cookie, /^gs_token=.+/);
  assert.equal((await c.req('GET', '/api/me')).body.id, user.id);
});

test('users: a wrong password gives no session, and malformed login bodies are 400', async () => {
  const { email } = await signup(app.base);
  const c = new Client(app.base);
  const wrong = await c.req('POST', '/api/auth/login', { email, password: 'password-124' });
  assert.equal(wrong.status, 401);
  assert.equal(c.cookie, '');
  assert.equal((await c.req('GET', '/api/me')).status, 401);
  for (const body of [{ email }, { password: PASSWORD }, { email, password: 'x'.repeat(129) }, { email: '', password: PASSWORD }, 'str']) {
    assert.equal((await c.req('POST', '/api/auth/login', body)).status, 400, JSON.stringify(body));
  }
});

test('users: GET /me reflects the stored row and needs a session', async () => {
  const { client, user } = await signup(app.base);
  const me = await client.req('GET', '/api/me');
  assert.equal(me.status, 200);
  const row = await userRow(user.id);
  assert.deepEqual(me.body, { id: row.id, email: row.email, name: row.name, createdAt: row.created_at.toISOString() });
  const anon = await new Client(app.base).req('GET', '/api/me');
  assert.equal(anon.status, 401);
  assert.equal(anon.body.error.code, 'unauthorized');
});

test('users: PATCH /me rename lands in the row, and GET /me returns it', async () => {
  const { client, user } = await signup(app.base);
  const hash = (await userRow(user.id)).password_hash;
  const res = await client.req('PATCH', '/api/me', { name: '  바뀐 이름  ' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, '바뀐 이름');
  const row = await userRow(user.id);
  assert.equal(row.name, '바뀐 이름');
  assert.equal(row.password_hash, hash, 'a rename leaves the password alone');
  assert.equal((await client.req('GET', '/api/me')).body.name, '바뀐 이름');
});

test('users: invalid PATCH /me bodies are refused and change nothing', async () => {
  const { client, user } = await signup(app.base);
  const before = await userRow(user.id);
  for (const body of [{ name: '' }, { name: 'x'.repeat(51) }, { name: 3 }, { password: 'short' }, { password: 'x'.repeat(129) }, { name: 'ok', password: 'short' }, [1]]) {
    assert.equal((await client.req('PATCH', '/api/me', body)).status, 400, JSON.stringify(body));
  }
  assert.deepEqual(await userRow(user.id), before);
});

test('users: an empty PATCH /me is a no-op', async () => {
  const { client, user } = await signup(app.base);
  const before = await userRow(user.id);
  const res = await client.req('PATCH', '/api/me', {});
  assert.equal(res.status, 200);
  assert.equal(res.body.name, before.name);
  assert.deepEqual(await userRow(user.id), before);
});

test('users: a password change rewrites the hash, ends the old cookie and keeps the new one', async () => {
  const { client, user, email } = await signup(app.base);
  const other = new Client(app.base);
  assert.equal((await other.req('POST', '/api/auth/login', { email, password: PASSWORD })).status, 200);
  const oldHash = (await userRow(user.id)).password_hash;
  const oldCookie = client.cookie;

  const res = await client.req('PATCH', '/api/me', { name: '둘 다', password: 'new-password-9' });
  assert.equal(res.status, 200);
  assert.equal(res.body.name, '둘 다');
  assert.notEqual(client.cookie, oldCookie);
  const row = await userRow(user.id);
  assert.notEqual(row.password_hash, oldHash);
  assert.match(row.password_hash, /^\$2b\$10\$/);
  assert.equal(row.name, '둘 다');

  assert.equal((await other.req('GET', '/api/me')).status, 401, 'the other session ended');
  const stale = new Client(app.base);
  stale.cookie = oldCookie;
  assert.equal((await stale.req('GET', '/api/me')).status, 401);
  assert.equal((await client.req('GET', '/api/me')).status, 200);
  assert.equal((await new Client(app.base).req('POST', '/api/auth/login', { email, password: 'new-password-9' })).status, 200);
});

test('users: DELETE /me removes the account and every row under it, and nothing of another user', async () => {
  const { client, user } = await signup(app.base);
  const keeper = await signup(app.base);
  const { server: kept } = await addServer(keeper.client);
  const { server } = await addServer(client);
  const id = server.id;
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 3, 0)', [id, now]);
  await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, 3, 0.003)', [id, new Date(now - 8 * 24 * HOUR)]);
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'p', 1, 1)", [id, now]);
  await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 3, 0)', [kept.id, now]);
  const consultation = await insertConsultation(id);
  const rec = await insertRec(id, { consultation_id: consultation, status: 'applied', applied_at: now });
  const call = await insertToolCall(consultation, { recommendation_id: rec, decision: 'approved', exit_code: 0, undo_command: 'u' });
  await insertToolCall(consultation, { command: 'u', undo_of: call, decision: 'approved', exit_code: 0 });

  const res = await client.req('DELETE', '/api/me');
  assert.equal(res.status, 204);
  assert.match(res.headers.get('set-cookie'), /gs_token=;/);
  assert.equal(await userRow(user.id), undefined);
  for (const table of ['servers', 'metrics', 'metrics_hourly', 'process_samples', 'consultations', 'recommendations']) {
    const column = table === 'servers' ? 'id' : 'server_id';
    assert.deepEqual(await rows(`SELECT * FROM ${table} WHERE ${column} = ?`, [id]), [], table);
  }
  assert.deepEqual(await rows('SELECT * FROM tool_calls'), []);
  assert.ok(await serverRow(kept.id));
  assert.equal((await rows('SELECT * FROM metrics WHERE server_id = ?', [kept.id])).length, 1);
  assert.equal((await keeper.client.req('GET', '/api/me')).status, 200);
  // The email is free again.
  assert.equal((await new Client(app.base).req('POST', '/api/auth/signup', { email: user.email, name: 'n', password: PASSWORD })).status, 201);
});

test('users: logout clears the cookie, and a request without it is 401', async () => {
  const { client } = await signup(app.base);
  const res = await client.req('POST', '/api/auth/logout');
  assert.equal(res.status, 204);
  assert.equal(client.cookie, 'gs_token=');
  assert.equal((await client.req('GET', '/api/me')).status, 401);
  assert.equal((await client.req('GET', '/api/servers')).status, 401);
});

// ---------------------------------------------------------------- servers

test('servers: every kind × ratePlan combination is created and stored as sent', async () => {
  const { client, user } = await signup(app.base);
  const cases = [];
  for (const kind of ['baremetal', 'home_pc', 'cloud_vm']) {
    cases.push({ name: `${kind}-home`, kind, ratePlan: 'home_tiered', householdKwh: 250 });
    cases.push({ name: `${kind}-cloud`, kind, ratePlan: 'cloud_hourly', hourlyKrw: 99.99 });
  }
  for (const input of cases) {
    const res = await client.req('POST', '/api/servers', input);
    assert.equal(res.status, 201, JSON.stringify(input));
    const row = await serverRow(res.body.server.id);
    assert.equal(row.user_id, user.id);
    assert.equal(row.name, input.name);
    assert.equal(row.kind, input.kind);
    assert.equal(row.rate_plan, input.ratePlan);
    assert.equal(row.power_source, input.kind === 'cloud_vm' ? 'estimated' : 'measured');
    assert.equal(row.hourly_krw, input.hourlyKrw ?? null);
    assert.equal(row.household_kwh, input.householdKwh ?? 0);
    assert.equal(res.body.server.powerSource, row.power_source);
  }
  assert.equal((await rows('SELECT id FROM servers WHERE user_id = ?', [user.id])).length, 6);
});

test('servers: hourlyKrw is optional on home_tiered and kept when sent', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client, { ...SERVER, hourlyKrw: 10 });
  assert.equal(server.hourlyKrw, 10);
  assert.equal((await serverRow(server.id)).hourly_krw, 10);
});

test('servers: column bounds — 100-char name, max hourlyKrw and householdKwh are accepted, one past is not', async () => {
  const { client } = await signup(app.base);
  const ok = await client.req('POST', '/api/servers', { name: 'n'.repeat(100), kind: 'cloud_vm', ratePlan: 'cloud_hourly', hourlyKrw: 99_999_999.99, householdKwh: 4_294_967_295 });
  assert.equal(ok.status, 201);
  const row = await serverRow(ok.body.server.id);
  assert.equal(row.hourly_krw, 99_999_999.99);
  assert.equal(row.household_kwh, 4_294_967_295);
  for (const bad of [
    { ...SERVER, name: 'n'.repeat(101) },
    { ...CLOUD, hourlyKrw: 100_000_000 },
    { ...SERVER, householdKwh: 4_294_967_296 },
    { ...CLOUD, hourlyKrw: Infinity },
    { ...SERVER, householdKwh: '300' },
  ]) {
    assert.equal((await client.req('POST', '/api/servers', bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await rows('SELECT id FROM servers')).length, 1);
});

test('servers: invalid POST bodies write nothing', async () => {
  const { client } = await signup(app.base);
  for (const bad of [[], 'x', { ...SERVER, name: 5 }, { ...SERVER, kind: undefined }, { ...SERVER, ratePlan: undefined }, { ...CLOUD, hourlyKrw: null }]) {
    const res = await client.req('POST', '/api/servers', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    // A bare JSON string is refused by the strict body parser before the route sees it.
    assert.equal(res.body.error.code, typeof bad === 'string' ? 'invalid_json' : 'validation_error');
  }
  assert.deepEqual(await rows('SELECT id FROM servers'), []);
  assert.equal((await new Client(app.base).req('POST', '/api/servers', SERVER)).status, 401);
});

test('servers: the name is trimmed, and each server gets its own agent token', async () => {
  const { client } = await signup(app.base);
  const a = await addServer(client, { ...SERVER, name: '  가운데  ' });
  const b = await addServer(client);
  assert.equal(a.server.name, '가운데');
  assert.equal((await serverRow(a.server.id)).name, '가운데');
  assert.notEqual(a.agentToken, b.agentToken);
  const hashes = await rows('SELECT agent_token_hash FROM servers ORDER BY id');
  assert.notEqual(hashes[0].agent_token_hash, hashes[1].agent_token_hash);
});

test('servers: GET list returns only the caller servers in id order; GET one matches the row', async () => {
  const { client } = await signup(app.base);
  const other = await signup(app.base);
  const first = (await addServer(client, { ...SERVER, name: 'one' })).server;
  await addServer(other.client, { ...SERVER, name: 'not mine' });
  const second = (await addServer(client, { ...CLOUD, name: 'two' })).server;

  const list = await client.req('GET', '/api/servers');
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.map((s) => [s.id, s.name]), [[first.id, 'one'], [second.id, 'two']]);

  const got = await client.req('GET', `/api/servers/${second.id}`);
  assert.equal(got.status, 200);
  const row = await serverRow(second.id);
  assert.equal(got.body.kind, row.kind);
  assert.equal(got.body.ratePlan, row.rate_plan);
  assert.equal(got.body.hourlyKrw, row.hourly_krw);
  assert.equal(got.body.createdAt, row.created_at.toISOString());
  assert.equal(got.body.location, null);
  assert.deepEqual(got.body, list.body[1]);
});

test('servers: an empty list is []; a deleted id is 404', async () => {
  const { client } = await signup(app.base);
  assert.deepEqual((await client.req('GET', '/api/servers')).body, []);
  const { server } = await addServer(client);
  await pool.query('DELETE FROM servers WHERE id = ?', [server.id]);
  assert.equal((await client.req('GET', `/api/servers/${server.id}`)).status, 404);
});

test('servers: PATCH each editable field alone, and the row changes only in that field', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const path = `/api/servers/${server.id}`;
  const steps = [
    [{ name: '새 이름' }, { name: '새 이름' }],
    [{ householdKwh: 0 }, { household_kwh: 0 }],
    [{ hourlyKrw: 33.33 }, { hourly_krw: 33.33 }],
    [{ ratePlan: 'cloud_hourly' }, { rate_plan: 'cloud_hourly' }],
    [{ kind: 'cloud_vm' }, { kind: 'cloud_vm', power_source: 'estimated' }],
    [{ kind: 'baremetal' }, { kind: 'baremetal', power_source: 'measured' }],
    [{ ratePlan: 'home_tiered', householdKwh: 410 }, { rate_plan: 'home_tiered', household_kwh: 410 }],
    [{ hourlyKrw: null }, { hourly_krw: null }],
  ];
  for (const [patch, changed] of steps) {
    const before = await serverRow(server.id);
    const res = await client.req('PATCH', path, patch);
    assert.equal(res.status, 200, JSON.stringify(patch));
    const after = await serverRow(server.id);
    assert.deepEqual(after, { ...before, ...changed }, JSON.stringify(patch));
    assert.equal(res.body.name, after.name);
    assert.equal(res.body.kind, after.kind);
    assert.equal(res.body.ratePlan, after.rate_plan);
    assert.equal(res.body.hourlyKrw, after.hourly_krw);
    assert.equal(res.body.householdKwh, after.household_kwh);
    assert.equal(res.body.powerSource, after.power_source);
  }
});

test('servers: a PATCH cannot reach columns outside the editable set', async () => {
  const { client, user } = await signup(app.base);
  const other = await signup(app.base);
  const { server } = await addServer(client);
  const before = await serverRow(server.id);
  const res = await client.req('PATCH', `/api/servers/${server.id}`, {
    powerSource: 'estimated',
    power_source: 'estimated',
    userId: other.user.id,
    user_id: other.user.id,
    agentTokenHash: 'f'.repeat(64),
    lastSeenAt: new Date().toISOString(),
  });
  assert.equal(res.status, 200);
  assert.deepEqual(await serverRow(server.id), before);
  assert.equal(before.user_id, user.id);
});

test('servers: an invalid PATCH is refused and leaves the row as it was', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const before = await serverRow(server.id);
  for (const bad of [{ kind: 'toaster' }, { ratePlan: 'free' }, { householdKwh: -5 }, { name: ' ' }, { ratePlan: 'cloud_hourly' }, [], { hourlyKrw: -0.01 }]) {
    assert.equal((await client.req('PATCH', `/api/servers/${server.id}`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.deepEqual(await serverRow(server.id), before);
});

test('servers: DELETE removes the server and its data, and leaves the owner and sibling servers', async () => {
  const { client, user } = await signup(app.base);
  const { server } = await addServer(client);
  const { server: sibling } = await addServer(client, CLOUD);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  for (const id of [server.id, sibling.id]) {
    await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 3, 0)', [id, now]);
    await pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'p', 1, 1)", [id, now]);
    await insertRec(id);
    await insertToolCall(await insertConsultation(id), {});
  }

  const res = await client.req('DELETE', `/api/servers/${server.id}`);
  assert.equal(res.status, 204);
  assert.equal(res.body, null);
  assert.equal(await serverRow(server.id), undefined);
  for (const table of ['metrics', 'process_samples', 'recommendations', 'consultations']) {
    assert.deepEqual(await rows(`SELECT * FROM ${table} WHERE server_id = ?`, [server.id]), [], table);
    assert.equal((await rows(`SELECT * FROM ${table} WHERE server_id = ?`, [sibling.id])).length, 1, table);
  }
  assert.equal((await rows('SELECT * FROM tool_calls')).length, 1);
  assert.ok(await userRow(user.id));
  assert.equal((await client.req('GET', `/api/servers/${server.id}`)).status, 404);
  assert.equal((await client.req('DELETE', `/api/servers/${server.id}`)).status, 404);
  assert.deepEqual((await client.req('GET', '/api/servers')).body.map((s) => s.id), [sibling.id]);
});

test("servers: another user's server is 404 for read, update and delete, and its row is untouched", async () => {
  const owner = await signup(app.base);
  const stranger = await signup(app.base);
  const { server } = await addServer(owner.client);
  const before = await serverRow(server.id);
  const path = `/api/servers/${server.id}`;
  for (const [method, body] of [['GET'], ['PATCH', { name: 'stolen', kind: 'cloud_vm' }], ['PATCH', { kind: 'toaster' }], ['DELETE']]) {
    const res = await stranger.client.req(method, path, body);
    assert.equal(res.status, 404, `${method} ${JSON.stringify(body)}`);
    assert.equal(res.body.error.code, 'not_found');
  }
  assert.deepEqual(await serverRow(server.id), before);
  assert.deepEqual((await stranger.client.req('GET', '/api/servers')).body, []);
});

// ---------------------------------------------------------------- metrics and processes

test('metrics: samples sent by the agent land in metrics and process_samples and come back through the API', async () => {
  const { client, server, agent } = await online();
  const ts = new Date(Math.floor(Date.now() / 10_000) * 10_000 - 20_000).toISOString();
  agent.send(metric({ ts, cpuPct: 33.3, memPct: 44.4, watts: 55.5, isEstimated: true }));
  const row = await waitFor(() => one('SELECT * FROM metrics WHERE server_id = ?', [server.id]));
  assert.deepEqual(row, { server_id: server.id, ts: new Date(ts), cpu_pct: 33.3, mem_pct: 44.4, watts: 55.5, is_estimated: 1 });
  const samples = await rows('SELECT pid, name, cpu_pct, watts FROM process_samples WHERE server_id = ? ORDER BY pid', [server.id]);
  assert.deepEqual(samples, [
    { pid: 1, name: 'small', cpu_pct: 1, watts: 2 },
    { pid: 2, name: 'big', cpu_pct: 50, watts: 30 },
  ]);
  assert.ok((await serverRow(server.id)).last_seen_at);

  const res = await client.req('GET', `/api/servers/${server.id}/metrics?range=1h`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, [{ ts, cpuPct: 33.3, memPct: 44.4, watts: 55.5, isEstimated: true }]);
  const procs = await client.req('GET', `/api/servers/${server.id}/processes`);
  assert.deepEqual(procs.body, [
    { ts, pid: 2, name: 'big', cpuPct: 50, watts: 30 },
    { ts, pid: 1, name: 'small', cpuPct: 1, watts: 2 },
  ]);
  await agent.close();
});

test('metrics: a re-sent sample is stored once', async () => {
  const { server, agent } = await online();
  const sample = metric();
  agent.send(sample);
  agent.send(sample);
  agent.send(metric({ ts: new Date(Date.now() - 10_000).toISOString(), processes: [] }));
  await waitFor(async () => (await rows('SELECT ts FROM metrics WHERE server_id = ?', [server.id])).length === 2);
  assert.equal((await rows('SELECT * FROM process_samples WHERE server_id = ?', [server.id])).length, 2);
  await agent.close();
});

test('metrics: each range has its own window and bucket size', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  // Aligned to 600 s so every bucket boundary below is predictable.
  const base = Math.floor(Date.now() / 600_000) * 600_000 - 600_000;
  const at = (offsetMs) => new Date(base + offsetMs);
  const samples = [
    [at(0), 10, 0],
    [at(5_000), 30, 1], // same 10 s bucket as the first
    [at(30_000), 50, 0], // same minute, same 10 min
    [at(-2 * HOUR), 100, 0], // only in 24h and 7d
    [at(-2 * 24 * HOUR), 200, 0], // only in 7d
    [at(-8 * 24 * HOUR), 999, 0], // in no range
  ];
  for (const [ts, watts, est] of samples) {
    await pool.query('INSERT INTO metrics VALUES (?, ?, 10, 20, ?, ?)', [server.id, ts, watts, est]);
  }
  const get = async (range) => {
    const res = await client.req('GET', `/api/servers/${server.id}/metrics${range ? `?range=${range}` : ''}`);
    assert.equal(res.status, 200, range);
    return res.body;
  };
  const hour = await get('1h');
  assert.deepEqual(hour.map((m) => [m.ts, m.watts, m.isEstimated]), [
    [at(0).toISOString(), 20, true],
    [at(30_000).toISOString(), 50, false],
  ]);
  assert.deepEqual(await get(undefined), hour, 'range defaults to 1h');
  const day = await get('24h');
  assert.deepEqual(day.map((m) => [m.ts, m.watts]), [
    [at(-2 * HOUR).toISOString(), 100],
    [at(0).toISOString(), 30],
  ]);
  const week = await get('7d');
  assert.deepEqual(week.map((m) => [m.ts, m.watts]), [
    [at(-2 * 24 * HOUR).toISOString(), 200],
    [at(-2 * HOUR).toISOString(), 100],
    [at(0).toISOString(), 30],
  ]);
  assert.equal(week[2].cpuPct, 10);
  assert.equal(week[2].memPct, 20);
  for (const bad of ['30d', '', '1H']) {
    const res = await client.req('GET', `/api/servers/${server.id}/metrics?range=${bad}`);
    assert.equal(res.status, 400, bad);
    assert.equal(res.body.error.code, 'validation_error');
  }
});

test('metrics: another server of the same owner never leaks into the chart', async () => {
  const { client } = await signup(app.base);
  const { server: a } = await addServer(client);
  const { server: b } = await addServer(client);
  await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 70, 0)', [b.id, new Date(Date.now() - 60_000)]);
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'b', 1, 1)", [b.id, new Date()]);
  assert.deepEqual((await client.req('GET', `/api/servers/${a.id}/metrics?range=7d`)).body, []);
  assert.deepEqual((await client.req('GET', `/api/servers/${a.id}/processes`)).body, []);
  assert.equal((await client.req('GET', `/api/servers/${b.id}/metrics?range=1h`)).body.length, 1);
});

test('processes: a newer sample replaces the list, and server delete removes the samples', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = Math.floor(Date.now() / 1000) * 1000;
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'a', 1, 5), (?, ?, 2, 'b', 1, 6)", [server.id, new Date(now - 10_000), server.id, new Date(now - 10_000)]);
  assert.deepEqual((await client.req('GET', `/api/servers/${server.id}/processes`)).body.map((p) => p.name), ['b', 'a']);
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 3, 'c', 2.5, 1.25)", [server.id, new Date(now)]);
  assert.deepEqual((await client.req('GET', `/api/servers/${server.id}/processes`)).body, [
    { ts: new Date(now).toISOString(), pid: 3, name: 'c', cpuPct: 2.5, watts: 1.25 },
  ]);
  await client.req('DELETE', `/api/servers/${server.id}`);
  assert.deepEqual(await rows('SELECT * FROM process_samples'), []);
});

// ---------------------------------------------------------------- recommendations

test('recommendations: list is newest first and maps every column', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const consultation = await insertConsultation(server.id);
  const a = await insertRec(server.id, { type: 'idle', est_saving_krw: 100 });
  const b = await insertRec(server.id, { source: 'ai', type: 'custom', detail: '설명', consultation_id: consultation, est_saving_krw: 250 });
  const res = await client.req('GET', `/api/servers/${server.id}/recommendations`);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.map((r) => r.id), [b, a]);
  const row = await recRow(b);
  assert.deepEqual(res.body[0], {
    id: b,
    serverId: server.id,
    consultationId: consultation,
    source: 'ai',
    type: 'custom',
    detail: '설명',
    estSavingKrw: 250,
    status: 'open',
    createdAt: row.created_at.toISOString(),
    appliedAt: null,
  });
  assert.equal(res.body[1].consultationId, null);
});

test('recommendations: runRules creates an open row that the list returns', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = Date.now();
  const values = Array.from({ length: 24 }, (_, i) => [server.id, new Date(now - (i + 1) * HOUR), 1, 5, 60, 0]);
  await pool.query('INSERT INTO metrics VALUES ?', [values]);
  await runRules(new Date(now));
  const stored = await rows('SELECT * FROM recommendations WHERE server_id = ?', [server.id]);
  assert.equal(stored.length, 1);
  assert.equal(stored[0].status, 'open');
  assert.equal(stored[0].source, 'rule');
  const listed = (await client.req('GET', `/api/servers/${server.id}/recommendations`)).body;
  assert.deepEqual(listed.map((r) => [r.id, r.type, r.estSavingKrw]), [[stored[0].id, stored[0].type, stored[0].est_saving_krw]]);
});

test('recommendations: dismiss writes status only, and a dismissed one refuses every transition', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const id = await insertRec(server.id);
  const res = await client.req('POST', `/api/recommendations/${id}/dismiss`);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'dismissed');
  assert.equal(res.body.appliedAt, null);
  const row = await recRow(id);
  assert.equal(row.status, 'dismissed');
  assert.equal(row.applied_at, null);
  for (const [action, code] of [['dismiss', 'not_open'], ['apply', 'not_open'], ['unapply', 'not_applied'], ['execute', 'not_open'], ['plan', 'not_open']]) {
    const again = await client.req('POST', `/api/recommendations/${id}/${action}`);
    assert.equal(again.status, 409, action);
    assert.equal(again.body.error.code, code, action);
  }
  assert.deepEqual(await recRow(id), row);
  assert.deepEqual(await rows('SELECT id FROM consultations'), []);
});

test('recommendations: apply stamps applied_at, unapply clears it, and the cycle can repeat', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const id = await insertRec(server.id);
  const path = (a) => `/api/recommendations/${id}/${a}`;

  assert.equal((await client.req('POST', path('unapply'))).body.error.code, 'not_applied', 'an open one cannot be unapplied');
  for (let round = 0; round < 2; round++) {
    const applied = await client.req('POST', path('apply'));
    assert.equal(applied.status, 200);
    const row = await recRow(id);
    assert.equal(row.status, 'applied');
    assert.ok(Math.abs(row.applied_at.getTime() - Date.now()) < 5_000);
    assert.equal(applied.body.appliedAt, row.applied_at.toISOString());

    const undone = await client.req('POST', path('unapply'));
    assert.equal(undone.status, 200);
    assert.equal(undone.body.status, 'open');
    assert.deepEqual(await one('SELECT status, applied_at FROM recommendations WHERE id = ?', [id]), { status: 'open', applied_at: null });
  }
  // A reopened one can still be dismissed.
  assert.equal((await client.req('POST', path('dismiss'))).body.status, 'dismissed');
});

test("recommendations: another user's recommendation is 404 on every action and does not move", async () => {
  const owner = await signup(app.base);
  const stranger = await signup(app.base);
  const { server } = await addServer(owner.client);
  const open = await insertRec(server.id);
  const applied = await insertRec(server.id, { status: 'applied', applied_at: new Date() });
  for (const [id, action] of [[open, 'dismiss'], [open, 'apply'], [open, 'execute'], [open, 'plan'], [applied, 'unapply']]) {
    const res = await stranger.client.req('POST', `/api/recommendations/${id}/${action}`);
    assert.equal(res.status, 404, action);
  }
  assert.equal((await recRow(open)).status, 'open');
  assert.equal((await recRow(applied)).status, 'applied');
  assert.equal((await owner.client.req('POST', '/api/recommendations/999999/apply')).status, 404);
});

test('recommendations: execute and plan are refused while the agent is offline and leave no consultation', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const id = await insertRec(server.id);
  for (const action of ['execute', 'plan']) {
    const res = await client.req('POST', `/api/recommendations/${id}/${action}`);
    assert.equal(res.status, 409, action);
    assert.equal(res.body.error.code, 'agent_offline');
  }
  assert.deepEqual(await rows('SELECT id FROM consultations'), []);
  assert.equal((await recRow(id)).status, 'open');
});

test('recommendations: execute with a plan that is not a finished consultation of this server is 400', async () => {
  const { client, server, agent } = await online();
  const id = await insertRec(server.id);
  const unfinished = await insertConsultation(server.id);
  const { server: elsewhere } = await addServer(client);
  const [done] = await pool.query("INSERT INTO consultations (server_id, auth_mode, status) VALUES (?, 'api_key', 'done')", [elsewhere.id]);
  for (const planConsultationId of [unfinished, done.insertId, 'abc', 0, 999999]) {
    const res = await client.req('POST', `/api/recommendations/${id}/execute`, { planConsultationId });
    assert.equal(res.status, 400, String(planConsultationId));
  }
  assert.equal((await rows('SELECT id FROM consultations')).length, 2, 'no consultation was started');
  await agent.close();
});

test('recommendations: execute starts a consultation row with the last settings and sends the task', async () => {
  const { client, server, agent } = await online();
  await startConsultation(client, agent, server.id, { authMode: 'api_key', model: 'claude-haiku-5-5' });
  const id = await insertRec(server.id, { detail: '게임 서버를 끕니다.' });
  const res = await client.req('POST', `/api/recommendations/${id}/execute`);
  assert.equal(res.status, 201);
  const start = await agent.next((m) => m.type === 'consultation_start' && m.consultationId === res.body.id);
  assert.equal(start.recommendationId, id);
  assert.equal(start.task, '게임 서버를 끕니다.');
  const row = await consultationRow(res.body.id);
  assert.equal(row.server_id, server.id);
  assert.equal(row.auth_mode, 'api_key');
  assert.equal(row.model, 'claude-haiku-5-5');
  assert.equal(row.status, 'requested');
  assert.equal((await recRow(id)).status, 'open', 'execute alone does not apply it');
  await agent.close();
});

// ---------------------------------------------------------------- consultations and tool calls

test('consultations: POST stores a requested row with the default model, and both GETs read it back', async () => {
  const { client, server, agent } = await online();
  const res = await client.req('POST', `/api/servers/${server.id}/consultations`, { authMode: 'subscription' });
  assert.equal(res.status, 201);
  const start = await agent.next((m) => m.type === 'consultation_start');
  assert.equal(start.consultationId, res.body.id);
  const row = await consultationRow(res.body.id);
  assert.equal(row.server_id, server.id);
  assert.equal(row.auth_mode, 'subscription');
  assert.equal(row.model, 'claude-sonnet-5-5');
  assert.equal(row.status, 'requested');
  assert.deepEqual(res.body, {
    id: row.id,
    serverId: server.id,
    requestedAt: row.requested_at.toISOString(),
    authMode: 'subscription',
    model: 'claude-sonnet-5-5',
    status: 'requested',
    summary: null,
    level: null,
    feedback: [],
    fixes: [],
  });

  const detail = await client.req('GET', `/api/consultations/${row.id}`);
  assert.equal(detail.status, 200);
  assert.deepEqual(detail.body, { ...res.body, toolCalls: [], stream: [] });
  const list = await client.req('GET', `/api/servers/${server.id}/consultations`);
  assert.deepEqual(list.body, [res.body]);
  await agent.close();
});

test('consultations: every listed model is accepted; list is newest first and per server', async () => {
  const { client, server, agent } = await online();
  const ids = [];
  for (const model of ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5']) {
    const c = await startConsultation(client, agent, server.id, { authMode: 'api_key', model });
    assert.equal((await consultationRow(c.id)).model, model);
    ids.push(c.id);
  }
  const { server: quiet } = await addServer(client);
  assert.deepEqual((await client.req('GET', `/api/servers/${quiet.id}/consultations`)).body, []);
  assert.deepEqual((await client.req('GET', `/api/servers/${server.id}/consultations`)).body.map((c) => c.id), ids.toReversed());
  for (const bad of [{}, { authMode: 'api_key', model: 'gpt' }, { authMode: 'api_key', model: 5 }, []]) {
    assert.equal((await client.req('POST', `/api/servers/${server.id}/consultations`, bad)).status, 400, JSON.stringify(bad));
  }
  assert.equal((await rows('SELECT id FROM consultations')).length, 4);
  await agent.close();
});

test('consultations: status reports from the agent update the row, and a finished one stays finished', async () => {
  const { client, server, agent } = await online();
  const { id } = await startConsultation(client, agent, server.id);
  agent.send({ type: 'consultation_status', consultationId: id, status: 'running' });
  await waitFor(async () => (await consultationRow(id)).status === 'running');
  agent.send({
    type: 'consultation_status',
    consultationId: id,
    status: 'done',
    summary: '요약',
    level: 'fair',
    feedback: ['a'],
    fixes: ['b', 'c'],
    recommendations: [{ type: 'custom', detail: '추가 조치', estSavingKrw: 77 }],
  });
  const row = await waitFor(async () => {
    const r = await consultationRow(id);
    return r.status === 'done' && r;
  });
  assert.equal(row.summary, '요약');
  assert.equal(row.server_level, 'fair');
  assert.deepEqual(row.feedback, ['a']);
  assert.deepEqual(row.fixes, ['b', 'c']);
  const recs = await rows('SELECT * FROM recommendations WHERE consultation_id = ?', [id]);
  assert.deepEqual(recs.map((r) => [r.source, r.type, r.detail, r.est_saving_krw, r.status]), [['ai', 'custom', '추가 조치', 77, 'open']]);

  agent.send({ type: 'consultation_status', consultationId: id, status: 'failed', summary: 'late' });
  agent.send(metric()); // a marker: once it lands, the status report before it has been handled
  await waitFor(() => one('SELECT ts FROM metrics WHERE server_id = ?', [server.id]));
  assert.equal((await consultationRow(id)).status, 'done');
  const detail = (await client.req('GET', `/api/consultations/${id}`)).body;
  assert.equal(detail.status, 'done');
  assert.equal(detail.summary, '요약');
  assert.equal(detail.level, 'fair');
  await agent.close();
});

test("consultations: another user's consultation is 404 and an unknown id is 404", async () => {
  const owner = await signup(app.base);
  const stranger = await signup(app.base);
  const { server } = await addServer(owner.client);
  const id = await insertConsultation(server.id);
  assert.equal((await stranger.client.req('GET', `/api/consultations/${id}`)).status, 404);
  assert.equal((await owner.client.req('GET', `/api/consultations/${id + 1000}`)).status, 404);
  assert.equal((await owner.client.req('GET', `/api/consultations/${id}`)).status, 200);
});

test('tool calls: a reported call is stored pending and appears under GET /consultations/:id', async () => {
  const { client, server, agent } = await online();
  const { id } = await startConsultation(client, agent, server.id);
  const row = await reportCall(agent, id, 'r-1');
  assert.equal(row.command, 'systemctl stop minecraft');
  assert.equal(row.tier, 'approve');
  assert.equal(row.decision, 'pending');
  assert.equal(row.undo_command, 'systemctl start minecraft');
  assert.equal(row.approved_at, null);
  assert.equal(row.exit_code, null);
  const detail = (await client.req('GET', `/api/consultations/${id}`)).body;
  assert.deepEqual(detail.toolCalls, [
    {
      id: row.id,
      consultationId: id,
      recommendationId: null,
      command: 'systemctl stop minecraft',
      tier: 'approve',
      decision: 'pending',
      approvedAt: null,
      exitCode: null,
      undoCommand: 'systemctl start minecraft',
      undoOf: null,
    },
  ]);
  await agent.close();
});

test('tool calls: approve writes decision and approved_at, relays to the agent, and the result lands', async () => {
  const { client, server, agent } = await online();
  const { id } = await startConsultation(client, agent, server.id);
  const call = await reportCall(agent, id, 'r-ok');
  const res = await client.req('POST', `/api/tool-calls/${call.id}/decision`, { decision: 'approved' });
  assert.equal(res.status, 200);
  let row = await callRow(call.id);
  assert.equal(row.decision, 'approved');
  assert.ok(row.approved_at);
  assert.equal(res.body.approvedAt, row.approved_at.toISOString());
  assert.deepEqual(await agent.next((m) => m.type === 'decision'), { type: 'decision', requestId: 'r-ok', decision: 'approved' });

  agent.send({ type: 'tool_result', requestId: 'r-ok', exitCode: 0 });
  row = await waitFor(async () => {
    const r = await callRow(call.id);
    return r.exit_code === 0 && r;
  });
  assert.equal(row.decision, 'approved');
  assert.equal((await client.req('GET', `/api/consultations/${id}`)).body.toolCalls[0].exitCode, 0);
  assert.equal((await client.req('POST', `/api/tool-calls/${call.id}/decision`, { decision: 'denied' })).body.error.code, 'not_pending');
  assert.equal((await callRow(call.id)).decision, 'approved');
  await agent.close();
});

test('tool calls: deny writes denied with no approved_at, and a result for it is ignored', async () => {
  const { client, server, agent } = await online();
  const { id } = await startConsultation(client, agent, server.id);
  const call = await reportCall(agent, id, 'r-no');
  const res = await client.req('POST', `/api/tool-calls/${call.id}/decision`, { decision: 'denied' });
  assert.equal(res.status, 200);
  assert.deepEqual(await one('SELECT decision, approved_at, exit_code FROM tool_calls WHERE id = ?', [call.id]), {
    decision: 'denied',
    approved_at: null,
    exit_code: null,
  });
  assert.equal((await agent.next((m) => m.type === 'decision')).decision, 'denied');
  agent.send({ type: 'tool_result', requestId: 'r-no', exitCode: 0 });
  agent.send(metric());
  await waitFor(() => one('SELECT ts FROM metrics WHERE server_id = ?', [server.id]));
  assert.equal((await callRow(call.id)).exit_code, null);
  await agent.close();
});

test('tool calls: invalid decisions and foreign or unknown ids change no row', async () => {
  const { client, server, agent } = await online();
  const stranger = await signup(app.base);
  const { id } = await startConsultation(client, agent, server.id);
  const call = await reportCall(agent, id, 'r-x');
  for (const body of [{ decision: 'auto' }, { decision: 'APPROVED' }, {}, []]) {
    assert.equal((await client.req('POST', `/api/tool-calls/${call.id}/decision`, body)).status, 400, JSON.stringify(body));
  }
  assert.equal((await stranger.client.req('POST', `/api/tool-calls/${call.id}/decision`, { decision: 'approved' })).status, 404);
  assert.equal((await client.req('POST', `/api/tool-calls/${call.id + 1000}/decision`, { decision: 'approved' })).status, 404);
  assert.equal((await stranger.client.req('POST', `/api/tool-calls/${call.id}/undo`)).status, 404);
  assert.equal((await callRow(call.id)).decision, 'pending');
  await agent.close();
});

test('tool calls: undo inserts an undo row, relays it, and a successful undo_result records exit 0', async () => {
  const { client, server, agent } = await online();
  const { id } = await startConsultation(client, agent, server.id);
  const call = await reportCall(agent, id, 'r-undo', { tier: 'approve', decision: 'auto' });
  agent.send({ type: 'tool_result', requestId: 'r-undo', exitCode: 0 });
  await waitFor(async () => (await callRow(call.id)).exit_code === 0);

  const res = await client.req('POST', `/api/tool-calls/${call.id}/undo`);
  assert.equal(res.status, 202);
  const undoRow = await callRow(res.body.id);
  assert.equal(undoRow.undo_of, call.id);
  assert.equal(undoRow.consultation_id, id);
  assert.equal(undoRow.command, 'systemctl start minecraft');
  assert.equal(undoRow.tier, 'approve');
  assert.equal(undoRow.decision, 'approved');
  assert.ok(undoRow.approved_at);
  assert.equal(undoRow.request_id, null);
  assert.equal(undoRow.exit_code, null);
  assert.deepEqual(await agent.next((m) => m.type === 'undo'), { type: 'undo', toolCallId: res.body.id, command: 'systemctl start minecraft' });
  assert.equal((await client.req('POST', `/api/tool-calls/${call.id}/undo`)).body.error.code, 'already_undone', 'one in flight blocks a second');

  agent.send({ type: 'undo_result', toolCallId: res.body.id, exitCode: 0 });
  await waitFor(async () => (await callRow(res.body.id)).exit_code === 0);
  const detail = (await client.req('GET', `/api/consultations/${id}`)).body;
  assert.deepEqual(detail.toolCalls.map((t) => [t.id, t.undoOf, t.exitCode]), [[call.id, null, 0], [res.body.id, call.id, 0]]);
  assert.equal((await client.req('POST', `/api/tool-calls/${call.id}/undo`)).body.error.code, 'already_undone');
  assert.equal((await rows('SELECT id FROM tool_calls WHERE undo_of = ?', [call.id])).length, 1);
  await agent.close();
});

test('tool calls: a failed undo can be retried, adding a second undo row', async () => {
  const { client, server, agent } = await online();
  const consultation = await insertConsultation(server.id);
  const call = await insertToolCall(consultation, { decision: 'approved', exit_code: 0, undo_command: 'u' });
  const first = await client.req('POST', `/api/tool-calls/${call}/undo`);
  assert.equal(first.status, 202);
  await agent.next((m) => m.type === 'undo' && m.toolCallId === first.body.id);
  agent.send({ type: 'undo_result', toolCallId: first.body.id, exitCode: 3 });
  await waitFor(async () => (await callRow(first.body.id)).exit_code === 3);
  const second = await client.req('POST', `/api/tool-calls/${call}/undo`);
  assert.equal(second.status, 202);
  assert.notEqual(second.body.id, first.body.id);
  assert.deepEqual((await rows('SELECT exit_code FROM tool_calls WHERE undo_of = ? ORDER BY id', [call])).map((r) => r.exit_code), [3, null]);
  await agent.close();
});

test('tool calls: an undo of a recommendation call reopens the recommendation in the row', async () => {
  const { client, server, agent } = await online();
  const consultation = await insertConsultation(server.id);
  const rec = await insertRec(server.id, { status: 'applied', applied_at: new Date() });
  const call = await insertToolCall(consultation, { recommendation_id: rec, decision: 'approved', exit_code: 0, undo_command: 'u' });
  assert.equal((await client.req('POST', `/api/recommendations/${rec}/unapply`)).body.error.code, 'has_tool_calls');
  const res = await client.req('POST', `/api/tool-calls/${call}/undo`);
  assert.equal(res.status, 202);
  assert.equal((await callRow(res.body.id)).recommendation_id, rec);
  agent.send({ type: 'undo_result', toolCallId: res.body.id, exitCode: 0 });
  await waitFor(async () => (await recRow(rec)).status === 'open');
  assert.equal((await recRow(rec)).applied_at, null);
  await agent.close();
});

test('tool calls: deleting the server removes its consultations, calls and undo rows', async () => {
  const { client, server, agent } = await online();
  const { id } = await startConsultation(client, agent, server.id);
  const call = await reportCall(agent, id, 'r-del', { decision: 'auto', tier: 'approve' });
  agent.send({ type: 'tool_result', requestId: 'r-del', exitCode: 0 });
  await waitFor(async () => (await callRow(call.id)).exit_code === 0);
  const undo = await client.req('POST', `/api/tool-calls/${call.id}/undo`);
  assert.equal(undo.status, 202);
  assert.equal((await client.req('DELETE', `/api/servers/${server.id}`)).status, 204);
  assert.deepEqual(await rows('SELECT id FROM consultations'), []);
  assert.deepEqual(await rows('SELECT id FROM tool_calls'), []);
  assert.equal((await client.req('GET', `/api/consultations/${id}`)).status, 404);
  assert.equal((await client.req('POST', `/api/tool-calls/${call.id}/undo`)).status, 404);
  await agent.close();
});
