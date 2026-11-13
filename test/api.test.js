import { addServer, Client, connectAgent, insertConsultation, insertToolCall, ORIGIN, resetDb, SERVER, signup, startApp } from './helpers.js';
import assert from 'node:assert/strict';
import { randomBytes, scryptSync } from 'node:crypto';
import { after, before, beforeEach, mock, test } from 'node:test';
import jwt from 'jsonwebtoken';
import { one, pool, rows, tx } from '../src/db.js';
import { kstMonth, savingKrw } from '../src/fees.js';
import { rollup, runRules } from '../src/jobs.js';
import { track } from '../src/toolCalls.js';

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
const floorHour = (t) => Math.floor(t / HOUR) * HOUR;

test('sessions use UTC so NOW() matches the bound Dates', async () => {
  const row = await one('SELECT ABS(TIMESTAMPDIFF(SECOND, NOW(), ?)) AS skew', [new Date()]);
  assert.ok(row.skew <= 1);
  const [a, b] = await Promise.all([pool.getConnection(), pool.getConnection()]);
  for (const c of [a, b]) {
    const [[zone]] = await c.query("SELECT @@session.time_zone AS tz");
    assert.equal(zone.tz, '+00:00');
    c.release();
  }
});

test('signup sets an HttpOnly Lax cookie and never returns the hash', async () => {
  const client = new Client(app.base);
  const res = await client.req('POST', '/api/auth/signup', { email: 'A@Test.dev ', name: ' 가나 ', password: 'password-123' });
  assert.equal(res.status, 201);
  assert.deepEqual(Object.keys(res.body).sort(), ['createdAt', 'email', 'id', 'name']);
  assert.equal(res.body.email, 'a@test.dev');
  assert.equal(res.body.name, '가나');
  assert.match(res.body.createdAt, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
  const cookie = res.headers.get('set-cookie');
  assert.match(cookie, /^gs_token=/);
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Lax/);
  const row = await one('SELECT password_hash FROM users WHERE id = ?', [res.body.id]);
  assert.match(row.password_hash, /^\$2b\$10\$/);
});

test('signup validates input and rejects duplicates', async () => {
  const c = new Client(app.base);
  const good = { email: 'dup@test.dev', name: 'n', password: 'password-123' };
  for (const bad of [
    { ...good, email: 'nope' },
    { ...good, email: 5 },
    { ...good, name: '' },
    { ...good, name: 'x'.repeat(51) },
    { ...good, password: 'short' },
    { ...good, password: 'x'.repeat(129) },
  ]) {
    const res = await c.req('POST', '/api/auth/signup', bad);
    assert.equal(res.status, 400, JSON.stringify(bad));
    assert.equal(res.body.error.code, 'validation_error');
  }
  assert.equal((await c.req('POST', '/api/auth/signup', good)).status, 201);
  const dup = await new Client(app.base).req('POST', '/api/auth/signup', { ...good, email: 'DUP@test.dev' });
  assert.equal(dup.status, 409);
  assert.equal(dup.body.error.code, 'email_taken');
});

test('malformed JSON gets the error envelope', async () => {
  const res = await fetch(`${app.base}/api/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{' });
  assert.equal(res.status, 400);
  assert.equal((await res.json()).error.code, 'invalid_json');
});

test('login, logout and session', async () => {
  const { email } = await signup(app.base);
  const c = new Client(app.base);
  assert.equal((await c.req('GET', '/api/me')).status, 401);
  const wrong = await c.req('POST', '/api/auth/login', { email, password: 'wrong-password' });
  assert.equal(wrong.status, 401);
  assert.equal(wrong.body.error.code, 'invalid_credentials');
  const unknown = await c.req('POST', '/api/auth/login', { email: 'ghost@test.dev', password: 'password-123' });
  assert.equal(unknown.status, 401);
  assert.equal(unknown.body.error.code, 'invalid_credentials');
  assert.equal((await c.req('POST', '/api/auth/login', { email, password: 'password-123' })).status, 200);
  assert.equal((await c.req('GET', '/api/me')).body.email, email);
  const out = await c.req('POST', '/api/auth/logout');
  assert.equal(out.status, 204);
  assert.match(out.headers.get('set-cookie'), /gs_token=;/);
});

test('bcrypt hashes log in, and a legacy scrypt hash is rehashed on its first login', async () => {
  const { email } = await signup(app.base);
  assert.equal((await new Client(app.base).req('POST', '/api/auth/login', { email, password: 'password-123' })).status, 200);

  // The format production stored before bcrypt.
  const salt = randomBytes(16).toString('hex');
  const legacy = `scrypt$${salt}$${scryptSync('old-password-1', salt, 32).toString('hex')}`;
  await pool.query("INSERT INTO users (email, name, password_hash) VALUES ('legacy@test.dev', 'l', ?)", [legacy]);
  const hashOf = async () => (await one('SELECT password_hash FROM users WHERE email = ?', ['legacy@test.dev'])).password_hash;
  const c = new Client(app.base);
  assert.equal((await c.req('POST', '/api/auth/login', { email: 'legacy@test.dev', password: 'wrong-password' })).status, 401);
  assert.equal(await hashOf(), legacy);
  assert.equal((await c.req('POST', '/api/auth/login', { email: 'legacy@test.dev', password: 'old-password-1' })).status, 200);
  assert.match(await hashOf(), /^\$2b\$10\$/);
  assert.equal((await c.req('GET', '/api/me')).body.email, 'legacy@test.dev');
  const again = new Client(app.base);
  assert.equal((await again.req('POST', '/api/auth/login', { email: 'legacy@test.dev', password: 'old-password-1' })).status, 200);
});

test('a foreign hash in password_hash fails login without crashing', async () => {
  await pool.query("INSERT INTO users (email, name, password_hash) VALUES ('seed@test.dev', 's', SHA2('x', 256))");
  const res = await new Client(app.base).req('POST', '/api/auth/login', { email: 'seed@test.dev', password: 'x' });
  assert.equal(res.status, 401);
});

test('tampered and wrongly signed tokens are unauthorized', async () => {
  const { client } = await signup(app.base);
  const c = new Client(app.base);
  c.cookie = `${client.cookie}x`;
  assert.equal((await c.req('GET', '/api/me')).status, 401);
  c.cookie = `gs_token=${jwt.sign({ sub: '1' }, 'other-secret')}`;
  assert.equal((await c.req('GET', '/api/me')).status, 401);
  c.cookie = `gs_token=${jwt.sign({ sub: '1' }, '', { algorithm: 'none' })}`;
  assert.equal((await c.req('GET', '/api/me')).status, 401);
});

test('PATCH /me changes the name and password', async () => {
  const { client, email } = await signup(app.base);
  assert.equal((await client.req('PATCH', '/api/me', { name: '새이름' })).body.name, '새이름');
  assert.equal((await client.req('PATCH', '/api/me', { name: '' })).status, 400);
  assert.equal((await client.req('PATCH', '/api/me', { password: 'new-password-1' })).status, 200);
  const c = new Client(app.base);
  assert.equal((await c.req('POST', '/api/auth/login', { email, password: 'password-123' })).status, 401);
  assert.equal((await c.req('POST', '/api/auth/login', { email, password: 'new-password-1' })).status, 200);
});

test('DELETE /me removes the account and kills the session', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const stale = client.cookie;
  assert.equal((await client.req('DELETE', '/api/me')).status, 204);
  assert.equal(await one('SELECT id FROM servers WHERE id = ?', [server.id]), undefined);
  const c = new Client(app.base);
  c.cookie = stale;
  assert.equal((await c.req('GET', '/api/me')).status, 401);
});

test('CORS allows only FRONT_ORIGIN', async () => {
  const c = new Client(app.base);
  const ok = await c.req('OPTIONS', '/api/me', undefined, { origin: ORIGIN });
  assert.equal(ok.status, 204);
  assert.equal(ok.headers.get('access-control-allow-origin'), ORIGIN);
  assert.equal(ok.headers.get('access-control-allow-credentials'), 'true');
  const evil = await c.req('OPTIONS', '/api/me', undefined, { origin: 'http://evil.test' });
  assert.equal(evil.headers.get('access-control-allow-origin'), null);
});

test('server creation reveals the token once and stores only its hash', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  assert.equal(server.powerSource, 'measured');
  assert.equal(server.hourlyKrw, null);
  assert.equal(server.householdKwh, 300);
  assert.equal(server.lastSeenAt, null);
  assert.equal('agentToken' in server, false);
  const row = await one('SELECT agent_token_hash FROM servers WHERE id = ?', [server.id]);
  assert.match(row.agent_token_hash, /^[0-9a-f]{64}$/);
  assert.notEqual(row.agent_token_hash, agentToken);
  const got = await client.req('GET', `/api/servers/${server.id}`);
  assert.equal('agentToken' in got.body, false);
  assert.equal(JSON.stringify(got.body).includes(row.agent_token_hash), false);
  assert.equal(got.body.online, false);
  assert.equal(got.body.latestWatts, null);
  assert.equal(got.body.isEstimated, null);
  assert.equal(got.body.monthlyKwh, 0);
  assert.equal(got.body.monthlyKrw, 0);
});

test('server input validation, including partial PATCH against stored state', async () => {
  const { client } = await signup(app.base);
  for (const bad of [
    {},
    { ...SERVER, name: '' },
    { ...SERVER, kind: 'toaster' },
    { ...SERVER, ratePlan: 'free' },
    { ...SERVER, householdKwh: -1 },
    { ...SERVER, householdKwh: 1.5 },
    { ...SERVER, ratePlan: 'cloud_hourly' },
    { ...SERVER, ratePlan: 'cloud_hourly', hourlyKrw: 'lots' },
    { ...SERVER, hourlyKrw: -1 },
  ]) {
    assert.equal((await client.req('POST', '/api/servers', bad)).status, 400, JSON.stringify(bad));
  }
  const { server } = await addServer(client);
  const path = `/api/servers/${server.id}`;
  assert.equal((await client.req('PATCH', path, { ratePlan: 'cloud_hourly' })).status, 400);
  const cloud = await client.req('PATCH', path, { ratePlan: 'cloud_hourly', hourlyKrw: 42.5, kind: 'cloud_vm' });
  assert.equal(cloud.status, 200);
  assert.equal(cloud.body.powerSource, 'estimated');
  assert.equal(cloud.body.hourlyKrw, 42.5);
  assert.equal(cloud.body.name, 'home');
  assert.equal((await client.req('PATCH', path, { hourlyKrw: null })).status, 400);
  assert.equal((await client.req('PATCH', path, { name: null })).status, 400);
  assert.equal((await client.req('PATCH', path, { name: 'renamed' })).body.hourlyKrw, 42.5);
});

test("other users' resources are 404 on every :id route", async () => {
  const owner = await signup(app.base);
  const stranger = await signup(app.base);
  const { server } = await addServer(owner.client);
  const consultation = await insertConsultation(server.id);
  const call = await insertToolCall(consultation, { undo_command: 'u', exit_code: 0, decision: 'approved' });
  const pending = await insertToolCall(consultation, {});
  const [rec] = await pool.query(
    "INSERT INTO recommendations (server_id, source, type, detail) VALUES (?, 'rule', 'idle', 'd')",
    [server.id],
  );

  const attempts = [
    ['GET', `/api/servers/${server.id}`],
    ['PATCH', `/api/servers/${server.id}`, { name: 'x' }],
    ['DELETE', `/api/servers/${server.id}`],
    ['GET', `/api/servers/${server.id}/metrics?range=1h`],
    ['GET', `/api/servers/${server.id}/processes`],
    ['GET', `/api/servers/${server.id}/recommendations`],
    ['POST', `/api/recommendations/${rec.insertId}/dismiss`],
    ['POST', `/api/recommendations/${rec.insertId}/apply`],
    ['POST', `/api/recommendations/${rec.insertId}/unapply`],
    ['GET', `/api/servers/${server.id}/consultations`],
    ['POST', `/api/servers/${server.id}/consultations`, { authMode: 'api_key' }],
    ['GET', `/api/consultations/${consultation}`],
    ['POST', `/api/tool-calls/${pending}/decision`, { decision: 'approved' }],
    ['POST', `/api/tool-calls/${call}/undo`],
    ['GET', `/api/reports/savings?serverId=${server.id}`],
  ];
  for (const [method, path, body] of attempts) {
    const res = await stranger.client.req(method, path, body);
    assert.equal(res.status, 404, `${method} ${path}`);
    assert.equal(res.body.error.code, 'not_found');
  }
  assert.equal((await stranger.client.req('GET', '/api/servers')).body.length, 0);
  // Nothing moved.
  const row = await one('SELECT decision FROM tool_calls WHERE id = ?', [pending]);
  assert.equal(row?.decision, 'pending');
  assert.equal((await owner.client.req('GET', `/api/servers/${server.id}`)).status, 200);
});

test('nonsense ids are 404, unknown routes use the error envelope', async () => {
  const { client } = await signup(app.base);
  for (const id of ['abc', '0', '-1', '1.5', '99999999999999999999']) {
    assert.equal((await client.req('GET', `/api/servers/${id}`)).status, 404, id);
  }
  const res = await client.req('GET', '/nope');
  assert.equal(res.status, 404);
  assert.equal(res.body.error.code, 'not_found');
});

test('metrics: oldest first, range validated', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = Math.floor(Date.now() / 1000) * 1000;
  for (const [ageSec, watts] of [[100, 10], [50, 20]]) {
    await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, ?, 0)', [server.id, new Date(now - ageSec * 1000), watts]);
  }
  const res = await client.req('GET', `/api/servers/${server.id}/metrics?range=1h`);
  assert.deepEqual(res.body.map((m) => m.watts), [10, 20]);
  assert.equal(res.body[0].isEstimated, false);
  assert.match(res.body[0].ts, /Z$/);
  assert.equal(res.body[0].ts, new Date(Math.floor((now - 100_000) / 10_000) * 10_000).toISOString());
  assert.equal((await client.req('GET', `/api/servers/${server.id}/metrics?range=2h`)).status, 400);
  assert.equal((await client.req('GET', `/api/servers/${server.id}/metrics?range=7d`)).body.length >= 1, true);
});

test('processes: latest sample only, watts descending, top 10', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = new Date(Math.floor(Date.now() / 1000) * 1000);
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 999, 'old', 1, 500)", [server.id, new Date(now.getTime() - 10_000)]);
  for (let pid = 1; pid <= 12; pid++) {
    await pool.query('INSERT INTO process_samples VALUES (?, ?, ?, ?, 1, ?)', [server.id, now, pid, `p${pid}`, pid]);
  }
  const { body } = await client.req('GET', `/api/servers/${server.id}/processes`);
  assert.equal(body.length, 10);
  assert.deepEqual(body.map((p) => p.pid), [12, 11, 10, 9, 8, 7, 6, 5, 4, 3]);
});

test('summary projects month-to-date from metrics and metrics_hourly without double counting', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = Date.now();
  const month = kstMonth(new Date(now));
  await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, 100, 5)', [server.id, month.start]);
  for (let i = 0; i < 30; i++) {
    await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 100, 1)', [server.id, new Date(now - i * 10_000)]);
  }
  const { body } = await client.req('GET', `/api/servers/${server.id}`);
  const toDate = 5 + (100 * 30 * 10) / 3_600_000;
  const expected = toDate + (month.remainingHours * 100) / 1000;
  assert.ok(Math.abs(body.monthlyKwh - expected) < 0.05, `${body.monthlyKwh} vs ${expected}`);
  assert.equal(body.monthlyCo2Kg, Math.round(body.monthlyKwh * 0.4594 * 100) / 100);
  assert.equal(body.latestWatts, 100);
  assert.equal(body.weekWatts, 100);
  assert.equal(body.isEstimated, true);
  assert.ok(body.monthlyKrw > 0);
});

test('rollup moves old metrics to hourly and leaves the rest', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = new Date();
  const eightDays = floorHour(now.getTime() - 8 * 24 * HOUR);
  const insert = 'INSERT INTO metrics VALUES (?, ?, 1, 2, ?, 0)';
  for (let i = 0; i < 360; i++) await pool.query(insert, [server.id, new Date(eightDays + i * 10_000), 100]);
  await pool.query(insert, [server.id, new Date(eightDays + HOUR), 300]); // second, sparse bucket
  const recent = new Date(now.getTime() - 60_000);
  await pool.query(insert, [server.id, recent, 50]);
  // Inside the hour that spans the 7-day line: must wait for that hour to close completely.
  const straddling = new Date(floorHour(now.getTime() - 7 * 24 * HOUR) + 1000);
  await pool.query(insert, [server.id, straddling, 70]);
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'old', 1, 1)", [server.id, new Date(eightDays)]);

  await rollup(now);

  const hourly = await rows('SELECT * FROM metrics_hourly ORDER BY hour');
  assert.equal(hourly.length, 2);
  assert.equal(hourly[0].hour.getTime(), eightDays);
  assert.equal(hourly[0].avg_watts, 100);
  assert.equal(hourly[0].kwh, 0.1); // 100 W for a full hour
  assert.equal(hourly[1].avg_watts, 300);
  const left = await rows('SELECT watts FROM metrics ORDER BY ts');
  assert.deepEqual(left.map((m) => m.watts), [70, 50]);
  assert.deepEqual(await rows('SELECT * FROM process_samples'), []);

  await rollup(now); // idempotent
  assert.equal((await rows('SELECT * FROM metrics_hourly')).length, 2);
});

test('a failed transaction leaves nothing behind', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  await assert.rejects(
    tx(async (c) => {
      await c.query('INSERT INTO metrics_hourly VALUES (?, ?, 1, 1)', [server.id, new Date()]);
      await c.query('DELETE FROM servers WHERE id = ?', [server.id]);
      throw new Error('boom');
    }),
    /boom/,
  );
  assert.deepEqual(await rows('SELECT * FROM metrics_hourly'), []);
  assert.ok(await one('SELECT id FROM servers WHERE id = ?', [server.id]));
});

function ruleSamples(serverId, now) {
  const values = Array.from({ length: 24 }, (_, i) => [serverId, new Date(now - (i + 1) * HOUR), 1, 5, 60, 0]);
  return pool.query('INSERT INTO metrics VALUES ?', [values]);
}

test('applying a rule recommendation records when and counts in the report', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const [inserted] = await pool.query("INSERT INTO recommendations (server_id, source, type, detail, est_saving_krw) VALUES (?, 'rule', 'idle', '끄기', 900)", [server.id]);
  const id = inserted.insertId;

  const applied = await client.req('POST', `/api/recommendations/${id}/apply`);
  assert.equal(applied.status, 200);
  assert.equal(applied.body.status, 'applied');
  assert.ok(applied.body.appliedAt);
  assert.equal((await client.req('POST', `/api/recommendations/${id}/apply`)).status, 409);
  assert.equal((await client.req('POST', `/api/recommendations/${id}/dismiss`)).status, 409);

  const report = (await client.req('GET', '/api/reports/savings')).body;
  assert.equal(report.bySource.find((s) => s.source === 'rule').applied, 1);

  const undone = await client.req('POST', `/api/recommendations/${id}/unapply`);
  assert.equal(undone.status, 200);
  assert.equal(undone.body.status, 'open');
  assert.equal(undone.body.appliedAt, null);
  assert.equal((await client.req('POST', `/api/recommendations/${id}/unapply`)).status, 409);
  const after = (await client.req('GET', '/api/reports/savings')).body;
  assert.equal(after.bySource.find((s) => s.source === 'rule').applied, 0);
});

test('an applied recommendation with executed commands cannot be unapplied', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const [inserted] = await pool.query("INSERT INTO recommendations (server_id, source, type, detail, status, applied_at) VALUES (?, 'ai', 'idle', '끄기', 'applied', NOW())", [server.id]);
  const id = inserted.insertId;
  const consultationId = await insertConsultation(server.id);
  await pool.query("INSERT INTO tool_calls (consultation_id, recommendation_id, command, tier, decision, exit_code) VALUES (?, ?, 'x', 'approve', 'auto', 0)", [consultationId, id]);

  const res = await client.req('POST', `/api/recommendations/${id}/unapply`);
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'has_tool_calls');
  assert.equal((await one('SELECT status FROM recommendations WHERE id = ?', [id])).status, 'applied');
});

test('rule job does not duplicate open recommendations and respects dismissal', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const now = Date.now();
  await ruleSamples(server.id, now);
  await runRules(new Date(now));
  await runRules(new Date(now));
  const path = `/api/servers/${server.id}/recommendations`;
  let recs = (await client.req('GET', path)).body;
  assert.equal(recs.length, 1);
  assert.equal(recs[0].type, 'idle');
  assert.equal(recs[0].source, 'rule');
  assert.equal(recs[0].status, 'open');
  assert.ok(recs[0].estSavingKrw > 0);

  const dismissed = await client.req('POST', `/api/recommendations/${recs[0].id}/dismiss`);
  assert.equal(dismissed.status, 200);
  assert.equal(dismissed.body.status, 'dismissed');
  assert.equal((await client.req('POST', `/api/recommendations/${recs[0].id}/dismiss`)).status, 409);

  await runRules(new Date(now));
  recs = (await client.req('GET', path)).body;
  assert.equal(recs.length, 1, 'a dismissed finding must not reappear on the next tick');
  await runRules(new Date(now + 8 * 24 * HOUR)); // no fresh data by then, nothing fires
  assert.equal((await client.req('GET', path)).body.length, 1);
});

test('tool-call decision state machine over HTTP', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const consultation = await insertConsultation(server.id);
  const decide = (id, decision) => client.req('POST', `/api/tool-calls/${id}/decision`, { decision });

  assert.equal((await decide(1, 'maybe')).status, 400);

  // A pending call the backend has no live request for cannot be relayed.
  const orphan = await insertToolCall(consultation, {});
  assert.equal((await decide(orphan, 'approved')).body.error.code, 'agent_offline');

  const deny = await insertToolCall(consultation, { tier: 'deny', decision: 'pending' });
  const res = await decide(deny, 'approved');
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'tier_denied');
  const row = await one('SELECT decision, approved_at FROM tool_calls WHERE id = ?', [deny]);
  assert.deepEqual(row, { decision: 'pending', approved_at: null });

  for (const decision of ['auto', 'approved', 'denied', 'blocked']) {
    const id = await insertToolCall(consultation, { decision });
    const again = await decide(id, 'approved');
    assert.equal(again.status, 409, decision);
    assert.equal(again.body.error.code, 'not_pending');
  }

  // Live path, then a second decision on the same call.
  const agent = await connectAgent(app.wsBase, agentToken);
  agent.send({ type: 'tool_call', consultationId: consultation, requestId: 'r1', command: 'c', tier: 'approve', decision: 'pending', undoCommand: null });
  const live = await waitFor(() => one("SELECT id FROM tool_calls WHERE consultation_id = ? AND command = 'c'", [consultation]));
  const denied = await decide(live.id, 'denied');
  assert.equal(denied.status, 200);
  assert.equal(denied.body.decision, 'denied');
  assert.equal(denied.body.approvedAt, null);
  assert.equal((await agent.next((m) => m.type === 'decision')).decision, 'denied');
  assert.equal((await decide(live.id, 'approved')).status, 409);
  await agent.close();
});

test('an undecided call expires to denied after 10 minutes, and late decisions are refused', async () => {
  const { client, user } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const consultation = await insertConsultation(server.id);
  const id = await insertToolCall(consultation, {});
  const agent = await connectAgent(app.wsBase, agentToken);
  mock.timers.enable({ apis: ['setTimeout'] });
  try {
    track({ serverId: server.id, userId: user.id, requestId: 'slow', toolCallId: id, consultationId: consultation }, true);
    mock.timers.tick(9 * 60_000);
    assert.equal((await one('SELECT decision FROM tool_calls WHERE id = ?', [id]))?.decision, 'pending');
    mock.timers.tick(60_000);
  } finally {
    mock.timers.reset();
  }
  await waitFor(() => one("SELECT id FROM tool_calls WHERE id = ? AND decision = 'denied'", [id]));
  const res = await client.req('POST', `/api/tool-calls/${id}/decision`, { decision: 'approved' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'not_pending');
  await agent.close();
});

async function waitFor(find) {
  for (let i = 0; i < 100; i++) {
    const found = await find();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  assert.fail('condition never held');
}

test('undo requires a recorded command, a success and a live agent', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const consultation = await insertConsultation(server.id);
  const undo = (id) => client.req('POST', `/api/tool-calls/${id}/undo`);

  const noCommand = await insertToolCall(consultation, { decision: 'approved', exit_code: 0 });
  assert.equal((await undo(noCommand)).body.error.code, 'not_undoable');
  const failed = await insertToolCall(consultation, { decision: 'approved', exit_code: 1, undo_command: 'u' });
  assert.equal((await undo(failed)).body.error.code, 'not_undoable');
  const unfinished = await insertToolCall(consultation, { decision: 'approved', undo_command: 'u' });
  assert.equal((await undo(unfinished)).body.error.code, 'not_undoable');
  const blocked = await insertToolCall(consultation, { decision: 'blocked', exit_code: 0, undo_command: 'u' });
  assert.equal((await undo(blocked)).body.error.code, 'not_undoable');

  const good = await insertToolCall(consultation, { decision: 'approved', exit_code: 0, undo_command: 'u' });
  assert.equal((await undo(good)).body.error.code, 'agent_offline');
  const agent = await connectAgent(app.wsBase, agentToken);
  const res = await undo(good);
  assert.equal(res.status, 202);
  assert.equal(res.body.undoOf, good);
  assert.equal(res.body.command, 'u');
  assert.equal(res.body.undoCommand, null);
  assert.equal((await undo(good)).body.error.code, 'already_undone');
  assert.equal((await undo(res.body.id)).body.error.code, 'not_undoable');
  await agent.close();
});

test('consultation is refused while the agent is offline', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const path = `/api/servers/${server.id}/consultations`;
  assert.equal((await client.req('POST', path, { authMode: 'nope' })).status, 400);
  assert.equal((await client.req('POST', path, { authMode: 'api_key', model: '--dangerously-skip-permissions' })).status, 400);
  const res = await client.req('POST', path, { authMode: 'api_key' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'agent_offline');
  assert.deepEqual((await client.req('GET', path)).body, []);
});

async function appliedRecommendation(serverId, source, appliedAt) {
  const [result] = await pool.query(
    "INSERT INTO recommendations (server_id, source, type, detail, status, applied_at) VALUES (?, ?, 'idle', 'd', 'applied', ?)",
    [serverId, source, appliedAt],
  );
  return result.insertId;
}

test('savings: before hours from metrics_hourly pair with after hours still in raw metrics', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client, { ...SERVER, householdKwh: 150 });
  const now = Date.now();
  const applied = new Date(now - 30 * HOUR);
  const appliedHour = floorHour(applied.getTime());
  const recId = await appliedRecommendation(server.id, 'ai', applied);
  await pool.query("INSERT INTO recommendations (server_id, source, type, detail) VALUES (?, 'rule', 'idle', 'open one')", [server.id]);

  for (let h = 1; h <= 23; h++) {
    await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, 200, 0.2)', [server.id, new Date(appliedHour - h * HOUR)]);
  }
  await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, 999, 1)', [server.id, new Date(appliedHour)]); // the action's hour: on neither side
  for (let t = appliedHour + HOUR; t < floorHour(now) + HOUR; t += HOUR) {
    await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 100, 0), (?, ?, 1, 2, 120, 0)', [server.id, new Date(t), server.id, new Date(t + 1000)]);
  }

  const { status, body } = await client.req('GET', `/api/reports/savings?serverId=${server.id}`);
  assert.equal(status, 200);
  assert.equal(body.items.length, 1);
  const [item] = body.items;
  assert.equal(item.recommendationId, recId);
  assert.equal(item.serverName, 'home');
  assert.equal(item.appliedAt, new Date(Math.round(applied.getTime() / 1000) * 1000).toISOString());
  assert.equal(item.beforeWatts, 200);
  assert.equal(item.afterWatts, 110);
  const month = kstMonth(new Date());
  assert.equal(item.savedKwhMonth, Math.round(((90 * month.hours) / 1000) * 100) / 100);
  const plan = { ratePlan: 'home_tiered', hourlyKrw: null, householdKwh: 150 };
  assert.equal(item.savedKrwMonth, Math.round(savingKrw(plan, 200, 90, month)));
  assert.equal(item.savedCo2KgMonth, Math.round(item.savedKwhMonth * 0.4594 * 100) / 100);
  assert.equal(body.total.savedKrwMonth, body.items.reduce((s, i) => s + i.savedKrwMonth, 0));

  assert.deepEqual(body.bySource.toSorted((a, b) => a.source.localeCompare(b.source)), [
    { source: 'ai', total: 1, applied: 1, savedKrwMonth: item.savedKrwMonth, savedCo2KgMonth: item.savedCo2KgMonth },
    { source: 'rule', total: 1, applied: 0, savedKrwMonth: 0, savedCo2KgMonth: 0 },
  ]);
});

test('savings: a stopped server counts as 0 W, and on cloud saves its hourly fee', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client, { name: 'vm', kind: 'cloud_vm', ratePlan: 'cloud_hourly', hourlyKrw: 100 });
  const applied = new Date(Date.now() - 30 * HOUR);
  const appliedHour = floorHour(applied.getTime());
  await appliedRecommendation(server.id, 'rule', applied);
  for (let h = 1; h <= 23; h++) {
    await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, 50, 0.05)', [server.id, new Date(appliedHour - h * HOUR)]);
  }
  const { body } = await client.req('GET', '/api/reports/savings');
  assert.equal(body.items.length, 1);
  assert.equal(body.items[0].afterWatts, 0);
  assert.equal(body.items[0].savedKrwMonth, 100 * kstMonth(new Date()).hours);
});

test('savings: a fresh action has no finished after-hour yet, but still counts as applied', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const applied = new Date(Date.now() - 60_000);
  await appliedRecommendation(server.id, 'ai', applied);
  await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, 50, 0.05)', [server.id, new Date(floorHour(applied.getTime()) - HOUR)]);
  const { body } = await client.req('GET', '/api/reports/savings');
  assert.deepEqual(body.items, []);
  const ai = body.bySource.find((s) => s.source === 'ai');
  assert.deepEqual(ai, { source: 'ai', total: 1, applied: 1, savedKrwMonth: 0, savedCo2KgMonth: 0 });
});

test('savings report is scoped to the caller and validates serverId', async () => {
  const owner = await signup(app.base);
  const stranger = await signup(app.base);
  const { server } = await addServer(owner.client);
  await appliedRecommendation(server.id, 'rule', new Date(Date.now() - 30 * HOUR));
  const { body } = await stranger.client.req('GET', '/api/reports/savings');
  assert.deepEqual(body.items, []);
  assert.equal(body.bySource.reduce((n, s) => n + s.total, 0), 0);
  assert.equal(body.bySource.length, 2);
  assert.equal((await stranger.client.req('GET', '/api/reports/savings?serverId=abc')).status, 400);
});

test('activity report keeps servers without recommendations and joins commands to their server', async () => {
  const { client } = await signup(app.base);
  const busy = (await addServer(client, { ...SERVER, name: 'busy' })).server;
  const quiet = (await addServer(client, { ...SERVER, name: 'quiet' })).server;
  await pool.query(
    "INSERT INTO recommendations (server_id, source, type, detail, est_saving_krw, status) VALUES (?, 'rule', 'idle', 'a', 100, 'open'), (?, 'rule', 'idle', 'b', 50, 'applied')",
    [busy.id, busy.id],
  );
  const consultationId = await insertConsultation(busy.id);
  await insertToolCall(consultationId, { command: 'uptime', tier: 'auto', decision: 'auto', exit_code: 0 });

  const stranger = await signup(app.base, 'stranger@example.com');
  const foreign = (await addServer(stranger.client, { ...SERVER, name: 'foreign' })).server;
  await insertToolCall(await insertConsultation(foreign.id), { command: 'secret' });

  const { status, body } = await client.req('GET', '/api/reports/activity');
  assert.equal(status, 200);
  assert.deepEqual(body.servers, [
    { serverId: busy.id, serverName: 'busy', total: 2, open: 1, applied: 1, openSavingKrw: 100 },
    { serverId: quiet.id, serverName: 'quiet', total: 0, open: 0, applied: 0, openSavingKrw: 0 },
  ]);
  assert.equal(body.calls.length, 1);
  assert.equal(body.calls[0].command, 'uptime');
  assert.equal(body.calls[0].serverName, 'busy');
  assert.equal(body.calls[0].consultationId, consultationId);
});

test('changing the password ends other sessions and keeps this one', async () => {
  const { client, email } = await signup(app.base);
  const other = new Client(app.base);
  assert.equal((await other.req('POST', '/api/auth/login', { email, password: 'password-123' })).status, 200);
  assert.equal((await client.req('PATCH', '/api/me', { password: 'new-password-1' })).status, 200);
  assert.equal((await client.req('GET', '/api/me')).status, 200);
  assert.equal((await other.req('GET', '/api/me')).status, 401);
});

test('an email is locked after repeated failed logins, and others are not', async () => {
  const { email } = await signup(app.base);
  const bystander = await signup(app.base);
  const c = new Client(app.base);
  for (let i = 0; i < 10; i++) {
    assert.equal((await c.req('POST', '/api/auth/login', { email, password: 'wrong-password' })).status, 401);
  }
  const locked = await c.req('POST', '/api/auth/login', { email, password: 'password-123' });
  assert.equal(locked.status, 429);
  assert.equal(locked.body.error.code, 'too_many_attempts');
  assert.equal((await c.req('POST', '/api/auth/login', { email: bystander.email, password: 'password-123' })).status, 200);
});

test('summary bills a cloud instance only for the hours it reported plus the rest of the month', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client, { name: 'vm', kind: 'cloud_vm', ratePlan: 'cloud_hourly', hourlyKrw: 100 });
  await pool.query('INSERT INTO metrics VALUES (?, ?, 1, 2, 50, 1)', [server.id, new Date()]);
  const { body } = await client.req('GET', `/api/servers/${server.id}`);
  const expected = 100 * (1 + kstMonth(new Date()).remainingHours);
  assert.ok(Math.abs(body.monthlyKrw - expected) <= 1, `${body.monthlyKrw} vs ${expected}`);
});

test('savings: two changes close together are each measured only across their own hours', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client, { ...SERVER, householdKwh: 150 });
  const t = floorHour(Date.now() - 40 * HOUR);
  const first = await appliedRecommendation(server.id, 'rule', new Date(t + 60_000));
  const second = await appliedRecommendation(server.id, 'ai', new Date(t + 2 * HOUR + 60_000));
  for (let h = t - 23 * HOUR; h <= t + 30 * HOUR; h += HOUR) {
    const watts = h < t ? 200 : h < t + 2 * HOUR ? 150 : 100;
    await pool.query('INSERT INTO metrics_hourly VALUES (?, ?, ?, 0.1)', [server.id, new Date(h), watts]);
  }
  const { body } = await client.req('GET', `/api/reports/savings?serverId=${server.id}`);
  const byId = new Map(body.items.map((i) => [i.recommendationId, [i.beforeWatts, i.afterWatts]]));
  assert.deepEqual(byId.get(first), [200, 150]);
  assert.deepEqual(byId.get(second), [150, 100]);
});
