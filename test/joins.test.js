// Every JOIN / aggregate query in src/, checked for exact values against real MySQL.
// Data is shaped so a wrong join (missing scope, wrong key, inner instead of outer) gives a visibly wrong number.
import { addServer, connectAgent, connectWeb, insertConsultation, insertToolCall, metric, resetDb, SERVER, signup, startApp } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { one, pool, rows } from '../src/db.js';
import { co2Kg, kstMonth, marginalHomeCostKrw, savingKrw } from '../src/fees.js';
import { rollup, runRules } from '../src/jobs.js';

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

const SEC = 1000;
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const floorHour = (t) => Math.floor(t / HOUR) * HOUR;
const floorSec = (t) => Math.floor(t / SEC) * SEC;
const round2 = (n) => Math.round(n * 100) / 100;
const HOME = { ratePlan: 'home_tiered', hourlyKrw: null, householdKwh: 300 };
const CLOUD = { name: 'vm', kind: 'cloud_vm', ratePlan: 'cloud_hourly', hourlyKrw: 10 };

const insertMetrics = (values) => pool.query('INSERT INTO metrics (server_id, ts, cpu_pct, mem_pct, watts, is_estimated) VALUES ?', [values]);
const m = (serverId, t, watts, { cpu = 1, mem = 2, est = 0 } = {}) => [serverId, new Date(t), cpu, mem, watts, est];
const hourly = (serverId, t, avgWatts, kwh) => pool.query('INSERT INTO metrics_hourly VALUES (?, ?, ?, ?)', [serverId, new Date(t), avgWatts, kwh]);

async function insertRec(serverId, fields = {}) {
  const [r] = await pool.query('INSERT INTO recommendations SET ?', [{ server_id: serverId, source: 'rule', type: 'idle', detail: 'd', ...fields }]);
  return r.insertId;
}

async function count(table, column, ids) {
  if (ids.length === 0) return 0;
  return Number((await one(`SELECT COUNT(*) AS n FROM ${table} WHERE ${column} IN (?)`, [ids])).n);
}

// ---------- GET /api/reports/activity: LEFT JOIN + GROUP BY per server ----------

test('activity: exact per-server counts and open saving, with a recommendation-less server kept as zeros', async () => {
  const a = await signup(app.base);
  const alpha = (await addServer(a.client, { ...SERVER, name: 'alpha' })).server;
  const beta = (await addServer(a.client, { ...SERVER, name: 'beta' })).server;
  const gamma = (await addServer(a.client, { ...SERVER, name: 'gamma' })).server;
  for (const saving of [100, 200, 300]) await insertRec(alpha.id, { est_saving_krw: saving });
  for (const saving of [1000, 2000]) await insertRec(alpha.id, { est_saving_krw: saving, status: 'applied', applied_at: new Date() });
  await insertRec(alpha.id, { est_saving_krw: 5000, status: 'dismissed' });
  await insertRec(gamma.id, { est_saving_krw: 700, status: 'applied', applied_at: new Date() });
  await insertRec(gamma.id, { est_saving_krw: 50, status: 'dismissed' });
  // Consultations and calls must not multiply the recommendation rows.
  for (let i = 0; i < 2; i++) await insertToolCall(await insertConsultation(alpha.id), { command: `c${i}` });
  await insertConsultation(beta.id);

  const b = await signup(app.base);
  const bServer = (await addServer(b.client, { ...SERVER, name: 'b-only' })).server;
  await insertRec(bServer.id, { est_saving_krw: 9999 });
  await insertRec(bServer.id, { est_saving_krw: 9999 });

  const mine = (await a.client.req('GET', '/api/reports/activity')).body;
  assert.deepEqual(mine.servers, [
    { serverId: alpha.id, serverName: 'alpha', total: 6, open: 3, applied: 2, openSavingKrw: 600 },
    { serverId: beta.id, serverName: 'beta', total: 0, open: 0, applied: 0, openSavingKrw: 0 },
    { serverId: gamma.id, serverName: 'gamma', total: 2, open: 0, applied: 1, openSavingKrw: 0 },
  ]);
  const theirs = (await b.client.req('GET', '/api/reports/activity')).body;
  assert.deepEqual(theirs.servers, [{ serverId: bServer.id, serverName: 'b-only', total: 2, open: 2, applied: 0, openSavingKrw: 19998 }]);
  assert.deepEqual(theirs.calls, []);
});

test('activity: a user with no servers gets empty lists, not other users rows', async () => {
  const a = await signup(app.base);
  const { server } = await addServer(a.client);
  await insertRec(server.id, { est_saving_krw: 1 });
  await insertToolCall(await insertConsultation(server.id), { command: 'x' });
  const c = await signup(app.base);
  const res = await c.client.req('GET', '/api/reports/activity');
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { servers: [], calls: [] });
});

// ---------- GET /api/reports/activity: INNER JOIN tool_calls → consultations → servers ----------

test('activity: calls carry their own server name and consultation, newest first, caller only', async () => {
  const a = await signup(app.base);
  const s1 = (await addServer(a.client, { ...SERVER, name: 's1' })).server;
  const s2 = (await addServer(a.client, { ...SERVER, name: 's2' })).server;
  const b = await signup(app.base);
  const bs = (await addServer(b.client, { ...SERVER, name: 'foreign' })).server;

  const c1 = await insertConsultation(s1.id);
  const c2 = await insertConsultation(s2.id);
  const c3 = await insertConsultation(s1.id);
  const cb = await insertConsultation(bs.id);
  const times = new Map([[c1, '2026-01-01 01:00:00'], [c2, '2026-01-02 02:00:00'], [c3, '2026-01-03 03:00:00'], [cb, '2026-01-04 04:00:00']]);
  for (const [id, t] of times) await pool.query('UPDATE consultations SET requested_at = ? WHERE id = ?', [t, id]);

  const t1 = await insertToolCall(c1, { command: 'one', tier: 'auto', decision: 'auto', exit_code: 0 });
  const t2 = await insertToolCall(c1, { command: 'two', tier: 'approve', decision: 'denied' });
  const tb = await insertToolCall(cb, { command: 'secret', exit_code: 9 });
  const t3 = await insertToolCall(c2, { command: 'three', tier: 'deny', decision: 'blocked' });
  const t4 = await insertToolCall(c3, { command: 'four', tier: 'approve', decision: 'approved', exit_code: 3 });

  const { calls } = (await a.client.req('GET', '/api/reports/activity')).body;
  assert.deepEqual(calls, [
    { id: t4, command: 'four', tier: 'approve', decision: 'approved', exitCode: 3, consultationId: c3, requestedAt: '2026-01-03T03:00:00.000Z', serverName: 's1' },
    { id: t3, command: 'three', tier: 'deny', decision: 'blocked', exitCode: null, consultationId: c2, requestedAt: '2026-01-02T02:00:00.000Z', serverName: 's2' },
    { id: t2, command: 'two', tier: 'approve', decision: 'denied', exitCode: null, consultationId: c1, requestedAt: '2026-01-01T01:00:00.000Z', serverName: 's1' },
    { id: t1, command: 'one', tier: 'auto', decision: 'auto', exitCode: 0, consultationId: c1, requestedAt: '2026-01-01T01:00:00.000Z', serverName: 's1' },
  ]);
  const foreign = (await b.client.req('GET', '/api/reports/activity')).body.calls;
  assert.deepEqual(foreign.map((c) => [c.id, c.serverName, c.consultationId, c.exitCode]), [[tb, 'foreign', cb, 9]]);
});

test('activity: calls are limited to the newest 60 of the caller, not 60 overall', async () => {
  const a = await signup(app.base);
  const { server } = await addServer(a.client);
  const b = await signup(app.base);
  const bs = (await addServer(b.client)).server;
  const ca = [await insertConsultation(server.id), await insertConsultation(server.id)];
  const cb = await insertConsultation(bs.id);
  const mine = [];
  const theirs = [];
  // Interleaved, and the stranger's are the newest overall.
  for (let i = 0; i < 65; i++) {
    mine.push(await insertToolCall(ca[i % 2], { command: `a${i}` }));
    if (i % 30 === 0) theirs.push(await insertToolCall(cb, { command: `b${i}` }));
  }
  for (let i = 0; i < 5; i++) theirs.push(await insertToolCall(cb, { command: `late${i}` }));

  const got = (await a.client.req('GET', '/api/reports/activity')).body.calls;
  assert.equal(got.length, 60);
  assert.deepEqual(got.map((c) => c.id), mine.toReversed().slice(0, 60));
  const other = (await b.client.req('GET', '/api/reports/activity')).body.calls;
  assert.deepEqual(other.map((c) => c.id), theirs.toReversed());
});

// ---------- models.js serverSummaries: LATERAL joins (latest, averages, month sums) ----------

test('server list: latest watts by ts, week average and estimate flag are per server and per user', async () => {
  const a = await signup(app.base);
  const s1 = (await addServer(a.client, { ...SERVER, name: 's1' })).server;
  const s2 = (await addServer(a.client, { ...SERVER, name: 's2' })).server;
  const b = await signup(app.base);
  const bs = (await addServer(b.client, { ...SERVER, name: 'b' })).server;
  const now = floorSec(Date.now());
  // Inserted newest first so insertion order and ts order disagree.
  await insertMetrics([
    m(s1.id, now - 10 * SEC, 90, { est: 1 }),
    m(s1.id, now - 30 * SEC, 50, { est: 1 }),
    m(s1.id, now - 20 * SEC, 70, { est: 0 }),
    m(s2.id, now - 15 * SEC, 100),
    m(s2.id, now - 5 * SEC, 300),
    m(bs.id, now - 1 * SEC, 5000, { est: 1 }),
  ]);

  const list = (await a.client.req('GET', '/api/servers')).body;
  assert.deepEqual(
    list.map((s) => [s.id, s.name, s.latestWatts, s.weekWatts, s.isEstimated]),
    [
      [s1.id, 's1', 90, 70, true],
      [s2.id, 's2', 300, 200, false],
    ],
  );
  const other = (await b.client.req('GET', '/api/servers')).body;
  assert.deepEqual(other.map((s) => [s.id, s.latestWatts, s.weekWatts, s.isEstimated]), [[bs.id, 5000, 5000, true]]);
  const single = (await a.client.req('GET', `/api/servers/${s2.id}`)).body;
  assert.deepEqual([single.id, single.latestWatts, single.weekWatts], [s2.id, 300, 200]);
});

test('server summary with no metrics: LEFT JOIN gives nulls and zero energy; cloud bills only the rest of the month', async () => {
  const { client } = await signup(app.base);
  const home = (await addServer(client)).server;
  const vm = (await addServer(client, CLOUD)).server;
  const [h, v] = (await client.req('GET', '/api/servers')).body;
  const month = kstMonth(new Date());
  assert.deepEqual([h.id, h.latestWatts, h.weekWatts, h.isEstimated, h.monthlyKwh, h.monthlyCo2Kg, h.monthlyKrw], [home.id, null, null, null, 0, 0, 0]);
  assert.deepEqual([v.id, v.latestWatts, v.weekWatts, v.isEstimated, v.monthlyKwh], [vm.id, null, null, null, 0]);
  assert.ok(Math.abs(v.monthlyKrw - 10 * month.remainingHours) <= 1, `${v.monthlyKrw} vs ${10 * month.remainingHours}`);
});

test('server summary: month kWh sums this month of hourly + raw, projects on the 24h average, week average spans 7 days', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const other = (await addServer(client, { ...SERVER, name: 'noise' })).server;
  const now = floorSec(Date.now());
  const month = kstMonth(new Date(now));
  await hourly(server.id, month.start.getTime() - HOUR, 999, 50); // last month: excluded
  await hourly(server.id, month.start.getTime(), 100, 1.5);
  await hourly(server.id, month.start.getTime() + HOUR, 200, 2.5);
  await hourly(other.id, month.start.getTime(), 100, 777); // another server: excluded
  const raw = [
    ...Array.from({ length: 6 }, (_, i) => [now - (i + 1) * 10 * SEC, 100]), // last 24h
    ...Array.from({ length: 3 }, (_, i) => [now - 30 * HOUR - i * SEC, 400]), // this week, not today
    [now - 8 * DAY, 1000], // older than a week
  ];
  await insertMetrics(raw.map(([t, w]) => m(server.id, t, w)));
  await insertMetrics([m(other.id, now - 5 * SEC, 9000)]);

  const body = (await client.req('GET', `/api/servers/${server.id}`)).body;
  const remaining = kstMonth(new Date()).remainingHours;
  const sampleWatts = raw.filter(([t]) => t >= month.start.getTime()).reduce((s, [, w]) => s + w, 0);
  const kwh = 4 + (sampleWatts * 10) / 3_600_000 + (remaining * 100) / 1000;
  assert.equal(body.latestWatts, 100);
  assert.equal(body.weekWatts, 200); // (6·100 + 3·400) / 9; the 8-day-old 1000 W is outside
  assert.ok(Math.abs(body.monthlyKwh - round2(kwh)) <= 0.01, `${body.monthlyKwh} vs ${kwh}`);
  assert.ok(Math.abs(body.monthlyCo2Kg - co2Kg(kwh)) <= 0.01, `${body.monthlyCo2Kg} vs ${co2Kg(kwh)}`);
  const krw = marginalHomeCostKrw(300, kwh, month.month);
  assert.ok(Math.abs(body.monthlyKrw - krw) <= 1, `${body.monthlyKrw} vs ${krw}`);
});

test('server summary: a cloud instance is billed for distinct raw hours + hourly rows this month + the rest', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client, CLOUD);
  const now = Date.now();
  const month = kstMonth(new Date(now));
  await hourly(server.id, month.start.getTime() - HOUR, 50, 0.05); // last month
  await hourly(server.id, month.start.getTime(), 50, 0.05);
  await hourly(server.id, month.start.getTime() + HOUR, 50, 0.05);
  await insertMetrics([
    m(server.id, floorHour(now - 3 * HOUR) + SEC, 50),
    m(server.id, floorHour(now - 3 * HOUR) + 2 * SEC, 50), // same hour: counted once
    m(server.id, floorHour(now - 2 * HOUR) + SEC, 50),
    m(server.id, floorHour(now - 1 * HOUR) + SEC, 50),
  ]);
  const body = (await client.req('GET', `/api/servers/${server.id}`)).body;
  const expected = 10 * Math.min(3 + 2 + kstMonth(new Date()).remainingHours, month.hours);
  assert.ok(Math.abs(body.monthlyKrw - expected) <= 1, `${body.monthlyKrw} vs ${expected}`);
});

// ---------- GET /servers/:id/metrics: GROUP BY time bucket ----------

test('metrics 1h: samples in one 10 s bucket are averaged, estimate is MAX, other servers never mix in', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const other = (await addServer(client, { ...SERVER, name: 'other' })).server;
  const base = Math.floor(Date.now() / 10_000) * 10_000 - 60 * SEC;
  await insertMetrics([
    m(server.id, base + 1 * SEC, 100, { cpu: 10, mem: 20, est: 0 }),
    m(server.id, base + 7 * SEC, 201, { cpu: 20, mem: 30, est: 1 }),
    m(server.id, base + 12 * SEC, 50, { cpu: 5, mem: 6, est: 0 }),
    m(server.id, base - 2 * HOUR, 7777), // outside 1h
    m(other.id, base + 3 * SEC, 9999, { cpu: 99, mem: 99, est: 1 }),
  ]);
  const { body } = await client.req('GET', `/api/servers/${server.id}/metrics?range=1h`);
  assert.deepEqual(body, [
    { ts: new Date(base).toISOString(), cpuPct: 15, memPct: 25, watts: 150.5, isEstimated: true },
    { ts: new Date(base + 10 * SEC).toISOString(), cpuPct: 5, memPct: 6, watts: 50, isEstimated: false },
  ]);
});

test('metrics 24h: 60 s buckets, ROUND(AVG, 2), oldest first', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const base = Math.floor(Date.now() / 60_000) * 60_000 - 120 * SEC;
  const old = Math.floor((Date.now() - 2 * HOUR) / 60_000) * 60_000;
  await insertMetrics([
    m(server.id, base + 1 * SEC, 1),
    m(server.id, base + 20 * SEC, 2),
    m(server.id, base + 59 * SEC, 2),
    m(server.id, old + 5 * SEC, 40),
    m(server.id, old + 6 * SEC, 41),
    m(server.id, Date.now() - 25 * HOUR, 1234), // outside 24h
  ]);
  const { body } = await client.req('GET', `/api/servers/${server.id}/metrics?range=24h`);
  assert.deepEqual(body.map((p) => [p.ts, p.watts]), [
    [new Date(old).toISOString(), 40.5],
    [new Date(base).toISOString(), 1.67],
  ]);
});

// ---------- GET /servers/:id/processes: JOIN servers + correlated MAX(ts) ----------

test('processes: the latest sample is taken per server, not the newest sample of any server', async () => {
  const { client } = await signup(app.base);
  const x = (await addServer(client, { ...SERVER, name: 'x' })).server;
  const y = (await addServer(client, { ...SERVER, name: 'y' })).server;
  const now = floorSec(Date.now());
  const insert = (sid, t, pid, watts) => pool.query("INSERT INTO process_samples VALUES (?, ?, ?, 'p', 1, ?)", [sid, new Date(t), pid, watts]);
  await insert(x.id, now - 20 * SEC, 1, 999);
  await insert(x.id, now - 10 * SEC, 2, 5);
  await insert(x.id, now - 10 * SEC, 3, 8);
  await insert(y.id, now, 4, 1); // newest of all, on another server
  const xs = (await client.req('GET', `/api/servers/${x.id}/processes`)).body;
  assert.deepEqual(xs.map((p) => [p.pid, p.watts, p.ts]), [
    [3, 8, new Date(now - 10 * SEC).toISOString()],
    [2, 5, new Date(now - 10 * SEC).toISOString()],
  ]);
  const ys = (await client.req('GET', `/api/servers/${y.id}/processes`)).body;
  assert.deepEqual(ys.map((p) => p.pid), [4]);
});

// ---------- RECOMMENDATION_SELECT / consultations / lockOwned: ownership joins ----------

test('recommendation routes resolve ownership through the server join', async () => {
  const a = await signup(app.base);
  const sa = (await addServer(a.client)).server;
  const sa2 = (await addServer(a.client, { ...SERVER, name: 'second' })).server;
  const b = await signup(app.base);
  const sb = (await addServer(b.client)).server;
  const r1 = await insertRec(sa.id, { est_saving_krw: 11 });
  const r2 = await insertRec(sa.id, { est_saving_krw: 22 });
  await insertRec(sa2.id, { est_saving_krw: 33 });
  const rb = await insertRec(sb.id, { est_saving_krw: 44 });

  const list = (await a.client.req('GET', `/api/servers/${sa.id}/recommendations`)).body;
  assert.deepEqual(list.map((r) => [r.id, r.serverId, r.estSavingKrw]), [[r2, sa.id, 22], [r1, sa.id, 11]]);

  for (const action of ['apply', 'dismiss', 'unapply', 'execute', 'plan']) {
    const res = await a.client.req('POST', `/api/recommendations/${rb}/${action}`);
    assert.equal(res.status, 404, action);
  }
  assert.equal((await one('SELECT status FROM recommendations WHERE id = ?', [rb])).status, 'open');

  const applied = await a.client.req('POST', `/api/recommendations/${r1}/apply`);
  assert.equal(applied.status, 200);
  assert.deepEqual([applied.body.id, applied.body.serverId, applied.body.status, applied.body.estSavingKrw], [r1, sa.id, 'applied', 11]);
  assert.ok(applied.body.appliedAt);
  assert.equal((await b.client.req('POST', `/api/recommendations/${rb}/dismiss`)).body.status, 'dismissed');
});

test('consultation detail joins to its owner and lists only its own calls in id order', async () => {
  const a = await signup(app.base);
  const sa = (await addServer(a.client)).server;
  const b = await signup(app.base);
  const sb = (await addServer(b.client)).server;
  const ca = await insertConsultation(sa.id);
  const cb = await insertConsultation(sb.id);
  const ca2 = await insertConsultation(sa.id);
  const t1 = await insertToolCall(ca, { command: 'first' });
  await insertToolCall(cb, { command: 'foreign' });
  await insertToolCall(ca2, { command: 'other consultation' });
  const t2 = await insertToolCall(ca, { command: 'second' });

  const detail = (await a.client.req('GET', `/api/consultations/${ca}`)).body;
  assert.equal(detail.id, ca);
  assert.equal(detail.serverId, sa.id);
  assert.deepEqual(detail.toolCalls.map((t) => [t.id, t.command, t.consultationId]), [[t1, 'first', ca], [t2, 'second', ca]]);
  assert.equal((await a.client.req('GET', `/api/consultations/${cb}`)).status, 404);
  assert.deepEqual((await a.client.req('GET', `/api/servers/${sa.id}/consultations`)).body.map((c) => c.id), [ca2, ca]);
});

test('tool-call decision and undo find a call only through consultation → server → user', async () => {
  const a = await signup(app.base);
  const sa = (await addServer(a.client)).server;
  const b = await signup(app.base);
  const sb = (await addServer(b.client)).server;
  const mine = await insertToolCall(await insertConsultation(sa.id), { decision: 'pending' });
  const cb = await insertConsultation(sb.id);
  const theirs = await insertToolCall(cb, { decision: 'pending' });
  const theirsDone = await insertToolCall(cb, { decision: 'approved', exit_code: 0, undo_command: 'undo' });

  assert.equal((await a.client.req('POST', `/api/tool-calls/${theirs}/decision`, { decision: 'approved' })).status, 404);
  assert.equal((await a.client.req('POST', `/api/tool-calls/${theirsDone}/undo`)).status, 404);
  assert.equal((await one('SELECT decision FROM tool_calls WHERE id = ?', [theirs])).decision, 'pending');
  assert.equal(await one('SELECT id FROM tool_calls WHERE undo_of = ?', [theirsDone]), undefined);
  // Found through the join, then refused for a different reason: the agent is not connected.
  const own = await a.client.req('POST', `/api/tool-calls/${mine}/decision`, { decision: 'approved' });
  assert.equal(own.status, 409);
  assert.equal(own.body.error.code, 'agent_offline');
});

// ---------- savings.js: CTE UNION ALL + JOIN + LEFT JOIN + NOT EXISTS + GROUP BY, and bySource ----------

async function applied(serverId, source, appliedAt) {
  return insertRec(serverId, { source, status: 'applied', applied_at: new Date(appliedAt) });
}

/** 23 hourly rows before the applied hour at `before` W, and the same clock hours a day later at `after` W (null: missing). */
async function beforeAfter(serverId, appliedHour, before, after) {
  for (let h = 1; h <= 23; h++) {
    await hourly(serverId, appliedHour - h * HOUR, before, before / 1000);
    if (after !== null) await hourly(serverId, appliedHour - h * HOUR + DAY, after, after / 1000);
  }
}

test('savings: each user sees only their own items and source counts', async () => {
  const a = await signup(app.base);
  const sa = (await addServer(a.client, { ...SERVER, householdKwh: 150 })).server;
  const b = await signup(app.base);
  const sb = (await addServer(b.client, { ...SERVER, householdKwh: 150 })).server;
  const at = floorSec(Date.now() - 30 * HOUR);
  const appliedHour = floorHour(at);
  const ra = await applied(sa.id, 'ai', at);
  await insertRec(sa.id, { status: 'dismissed' });
  await insertRec(sa.id);
  await beforeAfter(sa.id, appliedHour, 200, 120);
  const rb = await applied(sb.id, 'rule', at);
  await beforeAfter(sb.id, appliedHour, 1000, null);

  const month = kstMonth(new Date());
  const mine = (await a.client.req('GET', '/api/reports/savings')).body;
  assert.equal(mine.items.length, 1);
  const item = mine.items[0];
  assert.deepEqual([item.recommendationId, item.serverName, item.source, item.beforeWatts, item.afterWatts], [ra, 'home', 'ai', 200, 120]);
  assert.equal(item.savedKwhMonth, round2((80 * month.hours) / 1000));
  assert.equal(item.savedKrwMonth, Math.round(savingKrw({ ...HOME, householdKwh: 150 }, 200, 80, month)));
  assert.deepEqual(mine.bySource.toSorted((x, y) => x.source.localeCompare(y.source)), [
    { source: 'ai', total: 1, applied: 1, savedKrwMonth: item.savedKrwMonth, savedCo2KgMonth: item.savedCo2KgMonth },
    { source: 'rule', total: 2, applied: 0, savedKrwMonth: 0, savedCo2KgMonth: 0 },
  ]);
  assert.deepEqual(mine.total, { savedKrwMonth: item.savedKrwMonth, savedCo2KgMonth: item.savedCo2KgMonth });

  const theirs = (await b.client.req('GET', '/api/reports/savings')).body;
  assert.deepEqual(theirs.items.map((i) => [i.recommendationId, i.beforeWatts, i.afterWatts]), [[rb, 1000, 0]]);
  assert.deepEqual(theirs.bySource.toSorted((x, y) => x.source.localeCompare(y.source)).map((s) => [s.source, s.total, s.applied]), [
    ['ai', 0, 0],
    ['rule', 1, 1],
  ]);
});

test('savings: changes on two servers at the same hour do not exclude each other, and serverId filters everything', async () => {
  const { client } = await signup(app.base);
  const x = (await addServer(client, { ...SERVER, name: 'x', householdKwh: 150 })).server;
  const y = (await addServer(client, { ...CLOUD, hourlyKrw: 100 })).server;
  const at = floorSec(Date.now() - 30 * HOUR);
  const appliedHour = floorHour(at);
  const rx = await applied(x.id, 'rule', at);
  const ry = await applied(y.id, 'ai', at);
  await beforeAfter(x.id, appliedHour, 300, 100);
  await beforeAfter(y.id, appliedHour, 50, null); // stopped

  const month = kstMonth(new Date());
  const xKrw = Math.round(savingKrw({ ...HOME, householdKwh: 150 }, 300, 200, month));
  const yKrw = 100 * month.hours;
  const all = (await client.req('GET', '/api/reports/savings')).body;
  const byId = new Map(all.items.map((i) => [i.recommendationId, [i.serverName, i.beforeWatts, i.afterWatts, i.savedKrwMonth]]));
  assert.equal(all.items.length, 2);
  assert.deepEqual(byId.get(rx), ['x', 300, 100, xKrw]);
  assert.deepEqual(byId.get(ry), ['vm', 50, 0, yKrw]);
  assert.equal(all.total.savedKrwMonth, xKrw + yKrw);
  assert.equal(all.total.savedCo2KgMonth, round2(all.items.reduce((s, i) => s + i.savedCo2KgMonth, 0)));
  const bySource = Object.fromEntries(all.bySource.map((s) => [s.source, [s.total, s.applied, s.savedKrwMonth]]));
  assert.deepEqual(bySource, { rule: [1, 1, xKrw], ai: [1, 1, yKrw] });

  const onlyX = (await client.req('GET', `/api/reports/savings?serverId=${x.id}`)).body;
  assert.deepEqual(onlyX.items.map((i) => i.recommendationId), [rx]);
  assert.deepEqual(Object.fromEntries(onlyX.bySource.map((s) => [s.source, [s.total, s.applied]])), { rule: [1, 1], ai: [0, 0] });
  assert.equal(onlyX.total.savedKrwMonth, xKrw);
});

test('savings: raw metrics are averaged per hour first, and the after side joins only the same server', async () => {
  const { client } = await signup(app.base);
  const { server } = await addServer(client);
  const noise = (await addServer(client, { ...SERVER, name: 'noise' })).server;
  const at = floorSec(Date.now() - 30 * HOUR);
  const A = floorHour(at);
  await applied(server.id, 'rule', at);
  const h1 = A - 5 * HOUR;
  const h2 = A - 3 * HOUR;
  await insertMetrics([
    m(server.id, h1 + SEC, 100),
    m(server.id, h2 + SEC, 300),
    m(server.id, h2 + 2 * SEC, 400),
    m(server.id, h2 + 3 * SEC, 500),
    m(server.id, A + SEC, 5000), // the action's own hour: on neither side
    m(server.id, h1 + DAY + SEC, 40),
    m(server.id, h1 + DAY + 2 * SEC, 60),
    // h2 + 24h is missing: the server was off, so that hour counts as 0 W.
    m(noise.id, h2 + DAY + SEC, 9999),
  ]);
  const { items } = (await client.req('GET', `/api/reports/savings?serverId=${server.id}`)).body;
  assert.equal(items.length, 1);
  // Per-hour averages (100, 400) → 250, not the per-sample 325; after (50, 0) → 25.
  assert.deepEqual([items[0].beforeWatts, items[0].afterWatts], [250, 25]);
  assert.equal(items[0].savedKrwMonth, Math.round(savingKrw(HOME, 250, 225, kstMonth(new Date()))));
});

// ---------- jobs.js rollup: INSERT … SELECT GROUP BY server/hour with AVG and SUM ----------

test('rollup: hourly avg and kWh are computed per server and hour, raw rows past the cutoff are removed', async () => {
  const a = await signup(app.base);
  const sa = (await addServer(a.client)).server;
  const b = await signup(app.base);
  const sb = (await addServer(b.client)).server;
  const now = new Date(Date.UTC(2026, 10, 20, 12, 30));
  const H0 = floorHour(now.getTime() - 9 * DAY);
  const values = [];
  for (let i = 0; i < 360; i++) {
    values.push(m(sa.id, H0 + i * 10 * SEC, 100));
    values.push(m(sa.id, H0 + HOUR + i * 10 * SEC, i % 2 ? 200 : 400));
    values.push(m(sb.id, H0 + i * 10 * SEC, 1000)); // same timestamps, other server
  }
  values.push(m(sa.id, now.getTime() - HOUR, 50), m(sb.id, now.getTime() - 2 * HOUR, 70));
  await insertMetrics(values);
  const proc = (sid, t) => pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'p', 1, 1)", [sid, new Date(t)]);
  await proc(sa.id, H0);
  await proc(sb.id, H0);
  await proc(sa.id, now.getTime() - HOUR);

  await rollup(now);

  const rolled = await rows('SELECT server_id, hour, avg_watts, kwh FROM metrics_hourly ORDER BY server_id, hour');
  assert.deepEqual(rolled.map((r) => [r.server_id, r.hour.getTime(), r.avg_watts, r.kwh]), [
    [sa.id, H0, 100, 0.1],
    [sa.id, H0 + HOUR, 300, 0.3],
    [sb.id, H0, 1000, 1],
  ]);
  const left = await rows('SELECT server_id, watts FROM metrics ORDER BY server_id');
  assert.deepEqual(left.map((r) => [r.server_id, r.watts]), [[sa.id, 50], [sb.id, 70]]);
  assert.deepEqual((await rows('SELECT server_id FROM process_samples')).map((r) => r.server_id), [sa.id]);
});

test('rollup: moving raw metrics to hourly leaves the month kWh, bill and averages unchanged', async () => {
  const { client } = await signup(app.base);
  const home = (await addServer(client)).server;
  const vm = (await addServer(client, CLOUD)).server;
  const now = Date.now();
  const values = [];
  for (const sid of [home.id, vm.id]) {
    for (let h = 3; h <= 5; h++) for (let i = 0; i < 36; i++) values.push(m(sid, floorHour(now - h * HOUR) + i * 100 * SEC, 100));
    values.push(m(sid, floorSec(now - 60 * SEC), 100));
  }
  await insertMetrics(values);
  const summary = async () => (await client.req('GET', '/api/servers')).body.map((s) => [s.monthlyKwh, s.monthlyKrw, s.latestWatts, s.weekWatts]);
  const before = await summary();

  await rollup(new Date(now + 7 * DAY - 2 * HOUR)); // cutoff: the start of the hour two hours ago

  const hourlyRows = await rows('SELECT server_id, COUNT(*) AS n, SUM(kwh) AS kwh FROM metrics_hourly GROUP BY server_id ORDER BY server_id');
  assert.deepEqual(hourlyRows.map((r) => [r.server_id, Number(r.n), Number(r.kwh)]), [[home.id, 3, 0.03], [vm.id, 3, 0.03]]);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM metrics')).n), 2);
  const after = await summary();
  for (let i = 0; i < 2; i++) {
    assert.ok(Math.abs(after[i][0] - before[i][0]) <= 0.01, `kWh ${after[i][0]} vs ${before[i][0]}`);
    assert.ok(Math.abs(after[i][1] - before[i][1]) <= 1, `KRW ${after[i][1]} vs ${before[i][1]}`);
    assert.deepEqual(after[i].slice(2), [100, 100]);
  }
});

// ---------- jobs.js runRules: GROUP BY hour per server + INSERT … WHERE NOT EXISTS ----------

test('rule job: hourly stats are per server, and the NOT EXISTS guard is per server and type', async () => {
  const a = await signup(app.base);
  const x = (await addServer(a.client, { ...SERVER, name: 'x' })).server; // idle, already has an open idle
  const y = (await addServer(a.client, { ...SERVER, name: 'y' })).server; // busy in the same hours
  const z = (await addServer(a.client, { ...SERVER, name: 'z' })).server; // idle, nothing yet
  const b = await signup(app.base);
  const w = (await addServer(b.client, { ...SERVER, name: 'w' })).server; // idle, other user
  const now = Date.now();
  const values = [];
  for (let i = 1; i <= 24; i++) {
    for (const sid of [x.id, z.id, w.id]) values.push(m(sid, now - i * HOUR, 60, { cpu: 1, mem: 5 }));
    values.push(m(y.id, now - i * HOUR, 60, { cpu: 50, mem: 5 }));
  }
  await insertMetrics(values);
  const existing = await insertRec(x.id, { type: 'idle', est_saving_krw: 1 });
  await insertRec(z.id, { type: 'oversized', status: 'open' }); // another type does not block idle

  await runRules(new Date(now));

  const idle = await rows("SELECT id, server_id, est_saving_krw FROM recommendations WHERE type = 'idle' ORDER BY server_id, id");
  const est = Math.max(0, Math.round(savingKrw(HOME, 60, 60, kstMonth(new Date(now)))));
  assert.deepEqual(idle.map((r) => [r.server_id, r.est_saving_krw]), [[x.id, 1], [z.id, est], [w.id, est]]);
  assert.equal(idle[0].id, existing);
  assert.equal(Number((await one('SELECT COUNT(*) AS n FROM recommendations WHERE server_id = ?', [y.id])).n), 0);
});

// ---------- agent.js: joins on agent messages ----------

// The restart fallback in agent.js onToolResult must pick the call still waiting for a result: request_id is only
// unique per consultation, so an older consultation on the same server may have used the same id.
test('agent tool_result after a restart lands on the open call, even when an older consultation reused the request id', async () => {
  const { client } = await signup(app.base);
  const s = await addServer(client);
  const s2 = (await addServer(client, { ...SERVER, name: 'other' })).server;
  const old = await insertConsultation(s.server.id);
  const live = await insertConsultation(s.server.id);
  const foreign = await insertConsultation(s2.id);
  const done = await insertToolCall(old, { request_id: 'r-1', tier: 'auto', decision: 'auto', exit_code: 0 });
  const open = await insertToolCall(live, { request_id: 'r-1', tier: 'auto', decision: 'auto' });
  const otherServer = await insertToolCall(foreign, { request_id: 'r-1', tier: 'auto', decision: 'auto' });

  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, s.agentToken);
  agent.send({ type: 'tool_result', requestId: 'r-1', exitCode: 7 });
  agent.send(metric()); // barrier: messages are handled in order
  await web.next((msg) => msg.type === 'metric');
  const codes = await rows('SELECT id, exit_code FROM tool_calls WHERE id IN (?) ORDER BY id', [[done, open, otherServer]]);
  await agent.close();
  await web.close();
  assert.equal(codes.find((r) => r.id === otherServer).exit_code, null, 'another server is never touched');
  assert.equal(codes.find((r) => r.id === done).exit_code, 0);
  assert.equal(codes.find((r) => r.id === open).exit_code, 7, 'the result belongs to the call still waiting for one');
});

test('agent consultation done: only applied, not-undone approve calls of this consultation set applied_at (MAX)', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const [c] = await pool.query("INSERT INTO consultations (server_id, auth_mode, status) VALUES (?, 'api_key', 'running')", [server.id]);
  const cid = c.insertId;
  const otherC = await insertConsultation(server.id);
  const t = (iso) => new Date(iso);
  const call = (fields) => insertToolCall(cid, { tier: 'approve', decision: 'approved', exit_code: 0, ...fields });
  const undone = await call({ approved_at: t('2026-11-10T09:00:00Z') }); // latest, but undone
  await call({ approved_at: t('2026-11-11T00:00:00Z'), undo_of: undone, command: 'undo' }); // the undo row itself
  const kept = await call({ decision: 'auto', approved_at: t('2026-11-01T00:00:00Z') });
  await call({ exit_code: 1, approved_at: t('2026-11-09T00:00:00Z') }); // failed
  await call({ tier: 'auto', decision: 'auto', approved_at: t('2026-11-09T00:00:00Z') }); // auto tier: changes nothing
  const failedUndo = await call({ approved_at: t('2026-11-05T00:00:00Z') });
  await call({ approved_at: t('2026-11-12T00:00:00Z'), undo_of: failedUndo, exit_code: 1, command: 'undo' }); // undo failed: still in effect
  await insertToolCall(otherC, { tier: 'approve', decision: 'approved', exit_code: 0, approved_at: t('2026-11-13T00:00:00Z') });
  // undone's successful undo row (inserted above) has exit_code 0.

  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);
  agent.send({ type: 'consultation_status', consultationId: cid, status: 'done', summary: 's', recommendations: [{ type: 'idle', detail: 'd', estSavingKrw: 10 }] });
  await web.next((msg) => msg.type === 'consultation' && msg.consultation.id === cid && msg.consultation.status === 'done');
  await agent.close();
  await web.close();

  const rec = await one('SELECT id, consultation_id, source, status, applied_at FROM recommendations WHERE consultation_id = ?', [cid]);
  assert.deepEqual([rec.source, rec.status, rec.applied_at.toISOString()], ['ai', 'applied', '2026-11-05T00:00:00.000Z']);
  const linked = await rows('SELECT id FROM tool_calls WHERE recommendation_id = ? ORDER BY id', [rec.id]);
  assert.deepEqual(linked.map((r) => r.id), [kept, failedUndo]);
});

// ---------- foreign keys: ON DELETE CASCADE / SET NULL ----------

/** One server's worth of rows in every child table. Returns the ids to look for afterwards. */
async function seed(serverId, k) {
  const now = floorSec(Date.now());
  await insertMetrics([m(serverId, now - 10 * SEC, k), m(serverId, now - 20 * SEC, k), m(serverId, now - 30 * SEC, k)]);
  await hourly(serverId, floorHour(now - 9 * DAY), k, k / 1000);
  await hourly(serverId, floorHour(now - 9 * DAY) + HOUR, k, k / 1000);
  await pool.query("INSERT INTO process_samples VALUES (?, ?, 1, 'a', 1, 1), (?, ?, 2, 'b', 1, 1)", [serverId, new Date(now), serverId, new Date(now)]);
  const consultation = await insertConsultation(serverId);
  const rec = await insertRec(serverId, { consultation_id: consultation, status: 'applied', applied_at: new Date(now) });
  const free = await insertRec(serverId);
  const call = await insertToolCall(consultation, { recommendation_id: rec, decision: 'approved', exit_code: 0, undo_command: 'u' });
  const other = await insertToolCall(consultation, { recommendation_id: rec });
  const undoRow = await insertToolCall(consultation, { recommendation_id: rec, undo_of: call, command: 'u' });
  return { serverId, consultations: [consultation], recs: [rec, free], calls: [call, other, undoRow] };
}

async function snapshot(seeds) {
  const servers = seeds.map((s) => s.serverId);
  return {
    servers: await count('servers', 'id', servers),
    metrics: await count('metrics', 'server_id', servers),
    hourly: await count('metrics_hourly', 'server_id', servers),
    processes: await count('process_samples', 'server_id', servers),
    consultations: await count('consultations', 'id', seeds.flatMap((s) => s.consultations)),
    recommendations: await count('recommendations', 'id', seeds.flatMap((s) => s.recs)),
    toolCalls: await count('tool_calls', 'id', seeds.flatMap((s) => s.calls)),
  };
}

const EMPTY = { servers: 0, metrics: 0, hourly: 0, processes: 0, consultations: 0, recommendations: 0, toolCalls: 0 };
const PER_SERVER = { servers: 1, metrics: 3, hourly: 2, processes: 2, consultations: 1, recommendations: 2, toolCalls: 3 };
const times = (n) => Object.fromEntries(Object.entries(PER_SERVER).map(([k, v]) => [k, v * n]));

test('deleting a server cascades to metrics, hourly, processes, consultations, recommendations and tool calls (undo rows too)', async () => {
  const a = await signup(app.base);
  const doomed = await seed((await addServer(a.client)).server.id, 10);
  const sibling = await seed((await addServer(a.client, { ...SERVER, name: 'sibling' })).server.id, 20);
  const b = await signup(app.base);
  const stranger = await seed((await addServer(b.client)).server.id, 30);
  assert.deepEqual(await snapshot([doomed]), PER_SERVER);

  const res = await a.client.req('DELETE', `/api/servers/${doomed.serverId}`);
  assert.equal(res.status, 204);
  assert.deepEqual(await snapshot([doomed]), EMPTY);
  assert.deepEqual(await snapshot([sibling, stranger]), times(2));
  const left = (await a.client.req('GET', '/api/reports/activity')).body;
  assert.deepEqual(left.servers.map((s) => [s.serverId, s.total]), [[sibling.serverId, 2]]);
  assert.equal(left.calls.length, 3);
});

test('deleting a consultation removes its calls and sets recommendations.consultation_id to NULL', async () => {
  const { client } = await signup(app.base);
  const s = await seed((await addServer(client)).server.id, 10);
  const [consultation] = s.consultations;
  await pool.query('DELETE FROM consultations WHERE id = ?', [consultation]);
  assert.equal(await count('tool_calls', 'id', s.calls), 0);
  const recs = await rows('SELECT id, consultation_id, status FROM recommendations WHERE id IN (?) ORDER BY id', [s.recs]);
  assert.deepEqual(recs.map((r) => [r.id, r.consultation_id, r.status]), [[s.recs[0], null, 'applied'], [s.recs[1], null, 'open']]);
  const activity = (await client.req('GET', '/api/reports/activity')).body;
  assert.deepEqual([activity.servers[0].total, activity.servers[0].applied, activity.calls.length], [2, 1, 0]);
});

test('deleting a recommendation or an original call sets tool_calls.recommendation_id / undo_of to NULL', async () => {
  const { client } = await signup(app.base);
  const s = await seed((await addServer(client)).server.id, 10);
  const [call, other, undoRow] = s.calls;
  await pool.query('DELETE FROM recommendations WHERE id = ?', [s.recs[0]]);
  let got = await rows('SELECT id, recommendation_id, undo_of FROM tool_calls WHERE id IN (?) ORDER BY id', [s.calls]);
  assert.deepEqual(got.map((r) => [r.id, r.recommendation_id, r.undo_of]), [[call, null, null], [other, null, null], [undoRow, null, call]]);
  await pool.query('DELETE FROM tool_calls WHERE id = ?', [call]);
  got = await rows('SELECT id, undo_of FROM tool_calls WHERE id IN (?) ORDER BY id', [s.calls]);
  assert.deepEqual(got.map((r) => [r.id, r.undo_of]), [[other, null], [undoRow, null]]);
});

test('DELETE /api/me removes every row under the user and leaves the other users exactly as they were', async () => {
  const a = await signup(app.base);
  const mine = [await seed((await addServer(a.client)).server.id, 1), await seed((await addServer(a.client, { ...SERVER, name: 'two' })).server.id, 2)];
  const b = await signup(app.base);
  const c = await signup(app.base);
  const others = [await seed((await addServer(b.client)).server.id, 3), await seed((await addServer(c.client)).server.id, 4)];
  const before = await snapshot(others);
  const reportB = (await b.client.req('GET', '/api/reports/activity')).body;
  assert.deepEqual(await snapshot(mine), times(2));

  assert.equal((await a.client.req('DELETE', '/api/me')).status, 204);
  assert.equal(await one('SELECT id FROM users WHERE id = ?', [a.user.id]), undefined);
  assert.deepEqual(await snapshot(mine), EMPTY);
  assert.deepEqual(await snapshot(others), before);
  assert.deepEqual(before, times(2));
  assert.deepEqual((await b.client.req('GET', '/api/reports/activity')).body, reportB);
});
