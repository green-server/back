import { addServer, connect, connectAgent, connectWeb, metric, ORIGIN, resetDb, signup, startApp, toolCall } from './helpers.js';
import assert from 'node:assert/strict';
import { after, before, beforeEach, test } from 'node:test';
import { one, pool } from '../src/db.js';

let app: Awaited<ReturnType<typeof startApp>>;

before(async () => {
  await resetDb();
  app = await startApp();
});
beforeEach(resetDb);
after(async () => {
  await app.close();
  await pool.end();
});

const rejects = (promise: Promise<unknown>, status: number) => assert.rejects(promise, new Error(String(status)));

test('agent socket rejects missing and wrong tokens', async () => {
  await rejects(connect(`${app.wsBase}/ws/agent`, {}), 401);
  await rejects(connectAgent(app.wsBase, 'wrong'), 401);
  await rejects(connect(`${app.wsBase}/ws/agent`, { authorization: 'Basic abc' }), 401);
});

test('web socket checks Origin and cookie', async () => {
  const { client } = await signup(app.base);
  await rejects(connect(`${app.wsBase}/ws/web`, { origin: 'http://evil.test', cookie: client.cookie }), 403);
  await rejects(connect(`${app.wsBase}/ws/web`, { cookie: client.cookie }), 403);
  await rejects(connect(`${app.wsBase}/ws/web`, { origin: ORIGIN }), 401);
  await rejects(connect(`${app.wsBase}/ws/web`, { origin: ORIGIN, cookie: 'gs_token=junk' }), 401);
  await (await connectWeb(app.wsBase, client.cookie)).close();
});

test('unknown socket paths are refused', async () => {
  await rejects(connect(`${app.wsBase}/ws/other`, {}), 404);
});

test('agent happy path: metrics, consultation, approval, result, report, undo', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const serverId = server.id;
  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);

  assert.deepEqual(await web.next((m) => m.type === 'agent_status'), { type: 'agent_status', serverId, online: true });
  assert.equal((await client.req('GET', `/api/servers/${serverId}`)).body.online, true);

  agent.send({ type: 'hello', agentVersion: '1.0.0', hostname: 'box', os: 'linux' });
  const sample = metric();
  agent.send(sample);
  const event = await web.next((m) => m.type === 'metric');
  assert.equal(event.serverId, serverId);
  assert.deepEqual(event.metric, { ts: sample.ts, cpuPct: 12.5, memPct: 40, watts: 80, isEstimated: false });

  const summary = (await client.req('GET', `/api/servers/${serverId}`)).body;
  assert.equal(summary.latestWatts, 80);
  assert.equal(summary.isEstimated, false);
  assert.ok(summary.lastSeenAt);
  assert.ok(summary.monthlyKwh > 0);
  const processes = (await client.req('GET', `/api/servers/${serverId}/processes`)).body;
  assert.deepEqual(processes.map((p: any) => p.name), ['big', 'small']);

  const started = await client.req('POST', `/api/servers/${serverId}/consultations`, { authMode: 'subscription' });
  assert.equal(started.status, 201);
  assert.equal(started.body.status, 'requested');
  const consultationId = started.body.id;
  const start = await agent.next((m) => m.type === 'consultation_start');
  assert.equal(start.consultationId, consultationId);
  assert.equal(start.authMode, 'subscription');
  assert.equal(start.model, 'claude-sonnet-5-5');
  assert.ok(Number.isInteger(start.maxTurns) && start.maxTurns > 0);
  assert.equal(JSON.stringify(start).match(/token|key"/i), null);
  await web.next((m) => m.type === 'consultation' && m.consultation.status === 'requested');

  agent.send({ type: 'consultation_status', consultationId, status: 'running' });
  await web.next((m) => m.type === 'consultation' && m.consultation.status === 'running');

  // Auto call, with no wait between call and result: order must hold.
  agent.send(toolCall(consultationId, 'auto-1', { command: 'ps aux', tier: 'auto', decision: 'auto', undoCommand: null }));
  agent.send({ type: 'tool_result', requestId: 'auto-1', exitCode: 0 });
  const autoDone = await web.next((m) => m.type === 'tool_call' && m.toolCall.command === 'ps aux' && m.toolCall.exitCode === 0);
  assert.equal(autoDone.toolCall.decision, 'auto');

  // The agent gave up waiting: the call must not stay pending.
  agent.send(toolCall(consultationId, 'gave-up'));
  const { toolCall: abandoned } = await web.next((m) => m.type === 'tool_call' && m.toolCall.decision === 'pending');
  agent.send({ type: 'tool_result', requestId: 'gave-up', exitCode: null });
  await web.next((m) => m.type === 'tool_call' && m.toolCall.id === abandoned.id && m.toolCall.decision === 'denied');

  agent.send(toolCall(consultationId, 'req-1'));
  const { toolCall: pending } = await web.next((m) => m.type === 'tool_call' && m.toolCall.decision === 'pending');
  assert.equal(pending.command, 'systemctl stop minecraft');
  assert.equal(pending.tier, 'approve');
  assert.equal(pending.undoCommand, 'systemctl start minecraft');

  const decided = await client.req('POST', `/api/tool-calls/${pending.id}/decision`, { decision: 'approved' });
  assert.equal(decided.status, 200);
  assert.equal(decided.body.decision, 'approved');
  assert.ok(decided.body.approvedAt);
  assert.deepEqual(await agent.next((m) => m.type === 'decision'), { type: 'decision', requestId: 'req-1', decision: 'approved' });
  await web.next((m) => m.type === 'tool_call' && m.toolCall.id === pending.id && m.toolCall.decision === 'approved');

  agent.send({ type: 'tool_result', requestId: 'req-1', exitCode: 0 });
  await web.next((m) => m.type === 'tool_call' && m.toolCall.id === pending.id && m.toolCall.exitCode === 0);

  agent.send({
    type: 'consultation_status',
    consultationId,
    status: 'done',
    summary: '게임 서버를 껐습니다.',
    level: 'critical',
    feedback: ['유휴 전력이 큽니다.', 7],
    fixes: ['게임 서버를 중지합니다.'],
    recommendations: [
      { type: 'idle', detail: '주 조치', estSavingKrw: 1200.4 },
      { type: 'custom', detail: '다음 후보', estSavingKrw: 300 },
    ],
  });
  const done = await web.next((m) => m.type === 'consultation' && m.consultation.status === 'done');
  assert.equal(done.consultation.summary, '게임 서버를 껐습니다.');
  await web.next((m) => m.type === 'tool_call' && m.toolCall.id === pending.id && m.toolCall.recommendationId !== null);

  const recs = (await client.req('GET', `/api/servers/${serverId}/recommendations`)).body.toReversed();
  assert.deepEqual(recs.map((r: any) => [r.source, r.type, r.status, r.estSavingKrw]), [
    ['ai', 'idle', 'applied', 1200],
    ['ai', 'custom', 'open', 300],
  ]);
  assert.equal(recs[0].consultationId, consultationId);
  assert.equal(recs[0].appliedAt, decided.body.approvedAt);

  const detail = (await client.req('GET', `/api/consultations/${consultationId}`)).body;
  assert.equal(detail.status, 'done');
  assert.equal(detail.level, 'critical');
  assert.deepEqual(detail.feedback, ['유휴 전력이 큽니다.']);
  assert.deepEqual(detail.fixes, ['게임 서버를 중지합니다.']);
  assert.equal(detail.toolCalls.length, 3);
  assert.equal(detail.toolCalls[2].recommendationId, recs[0].id);

  const undone = await client.req('POST', `/api/tool-calls/${pending.id}/undo`);
  assert.equal(undone.status, 202);
  assert.equal(undone.body.undoOf, pending.id);
  assert.deepEqual(await agent.next((m) => m.type === 'undo'), { type: 'undo', toolCallId: undone.body.id, command: 'systemctl start minecraft' });
  agent.send({ type: 'undo_result', toolCallId: undone.body.id, exitCode: 0 });
  await web.next((m) => m.type === 'tool_call' && m.toolCall.id === undone.body.id && m.toolCall.exitCode === 0);
  const reopened = (await client.req('GET', `/api/servers/${serverId}/recommendations`)).body.find((r: any) => r.id === recs[0].id);
  assert.equal(reopened.status, 'open');
  assert.equal(reopened.appliedAt, null);

  await agent.close();
  assert.deepEqual(await web.next((m) => m.type === 'agent_status' && !m.online), { type: 'agent_status', serverId, online: false });
  await web.close();
});

test('bad agent messages are ignored and the connection keeps working', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);

  agent.ws.send('not json');
  agent.ws.send('[1]');
  agent.send({ type: 'unknown' });
  for (const bad of [
    { cpuPct: 101 },
    { cpuPct: '5' },
    { watts: -1 },
    { isEstimated: 1 },
    { ts: 'yesterday' },
    { ts: new Date(Date.now() - 8 * 24 * 3_600_000).toISOString() },
    { ts: new Date(Date.now() + 3_600_000).toISOString() },
    { processes: 'none' },
    { processes: [{ pid: -1, name: 'x', cpuPct: 1, watts: 1 }] },
  ]) {
    agent.send(metric(bad));
  }
  const good = metric({ watts: 42 });
  agent.send(good);
  assert.equal((await web.next((m) => m.type === 'metric')).metric.watts, 42);
  const count = await one<{ n: number }>('SELECT COUNT(*) AS n FROM metrics WHERE server_id = ?', [server.id]);
  assert.equal(count?.n, 1);
  await agent.close();
  await web.close();
});

test('a malformed optional field does not cost the status or the audit record', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);
  const { id: consultationId } = (await client.req('POST', `/api/servers/${server.id}/consultations`, { authMode: 'api_key' })).body;

  agent.send(toolCall(consultationId, 'r', { undoCommand: '' }));
  const { toolCall: call } = await web.next((m) => m.type === 'tool_call');
  assert.equal(call.undoCommand, null);

  agent.send({
    type: 'consultation_status',
    consultationId,
    status: 'done',
    summary: 5,
    recommendations: [{ type: 'idle' }, { type: 'x'.repeat(41), detail: 'd', estSavingKrw: 1 }, { type: 'ok', detail: 'd', estSavingKrw: 1 }],
  });
  const done = await web.next((m) => m.type === 'consultation' && m.consultation.status === 'done');
  assert.equal(done.consultation.summary, null);
  const recs = (await client.req('GET', `/api/servers/${server.id}/recommendations`)).body;
  assert.deepEqual(recs.map((r: any) => r.type), ['ok']);
  for (const peer of [agent, web]) await peer.close();
});

test('an agent cannot reach another server', async () => {
  const owner = await signup(app.base);
  const mine = await addServer(owner.client);
  const other = await addServer(owner.client, { name: 'other', kind: 'home_pc', ratePlan: 'home_tiered' });
  const web = await connectWeb(app.wsBase, owner.client.cookie);
  const agent = await connectAgent(app.wsBase, mine.agentToken);
  const otherAgent = await connectAgent(app.wsBase, other.agentToken);

  const { id: foreign } = (await owner.client.req('POST', `/api/servers/${other.server.id}/consultations`, { authMode: 'api_key' })).body;
  agent.send(toolCall(foreign, 'x'));
  agent.send({ type: 'consultation_status', consultationId: foreign, status: 'done', recommendations: [] });
  agent.send(metric()); // barrier: messages are handled in order
  await web.next((m) => m.type === 'metric');

  const row = await one<{ status: string }>('SELECT status FROM consultations WHERE id = ?', [foreign]);
  assert.equal(row?.status, 'requested');
  assert.equal(await one('SELECT id FROM tool_calls WHERE consultation_id = ?', [foreign]), undefined);

  // Undo rows are bound to their server too.
  const [call] = (await pool.query(
    "INSERT INTO tool_calls (consultation_id, command, tier, decision, undo_of) VALUES (?, 'c', 'approve', 'approved', NULL)",
    [foreign],
  )) as any;
  const [undoRow] = (await pool.query(
    "INSERT INTO tool_calls (consultation_id, command, tier, decision, undo_of) VALUES (?, 'u', 'approve', 'approved', ?)",
    [foreign, call.insertId],
  )) as any;
  agent.send({ type: 'undo_result', toolCallId: undoRow.insertId, exitCode: 0 });
  agent.send(metric({ ts: new Date(Date.now() + 2000).toISOString() }));
  await web.next((m) => m.type === 'metric');
  const undo = await one<{ exit_code: number | null }>('SELECT exit_code FROM tool_calls WHERE id = ?', [undoRow.insertId]);
  assert.equal(undo?.exit_code, null);

  for (const peer of [agent, otherAgent, web]) await peer.close();
});

test('web events reach only the owner', async () => {
  const owner = await signup(app.base);
  const stranger = await signup(app.base);
  const { agentToken } = await addServer(owner.client);
  const ownerWeb = await connectWeb(app.wsBase, owner.client.cookie);
  const strangerWeb = await connectWeb(app.wsBase, stranger.client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);
  agent.send(metric());
  await ownerWeb.next((m) => m.type === 'metric');
  await assert.rejects(strangerWeb.next(() => true, 200));
  for (const peer of [agent, ownerWeb, strangerWeb]) await peer.close();
});

test('deny tier is stored as blocked and cannot be approved', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);
  const { id: consultationId } = (await client.req('POST', `/api/servers/${server.id}/consultations`, { authMode: 'api_key' })).body;

  agent.send(toolCall(consultationId, 'evil', { command: 'rm -rf /', tier: 'deny', decision: 'pending', undoCommand: null }));
  const { toolCall: call } = await web.next((m) => m.type === 'tool_call');
  assert.equal(call.decision, 'blocked');
  const res = await client.req('POST', `/api/tool-calls/${call.id}/decision`, { decision: 'approved' });
  assert.equal(res.status, 409);
  assert.equal(res.body.error.code, 'tier_denied');

  // A result for it is not a result: it never ran.
  agent.send({ type: 'tool_result', requestId: 'evil', exitCode: 0 });
  agent.send(metric());
  await web.next((m) => m.type === 'metric');
  const row = await one<{ decision: string; exit_code: number | null }>('SELECT decision, exit_code FROM tool_calls WHERE id = ?', [call.id]);
  assert.deepEqual(row, { decision: 'blocked', exit_code: null });
  for (const peer of [agent, web]) await peer.close();
});

test('a denied call ignores any later result, and terminal consultations stay terminal', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);
  const { id: consultationId } = (await client.req('POST', `/api/servers/${server.id}/consultations`, { authMode: 'api_key' })).body;

  agent.send(toolCall(consultationId, 'r'));
  const { toolCall: call } = await web.next((m) => m.type === 'tool_call');
  await client.req('POST', `/api/tool-calls/${call.id}/decision`, { decision: 'denied' });
  agent.send({ type: 'tool_result', requestId: 'r', exitCode: 0 });

  agent.send({ type: 'consultation_status', consultationId, status: 'done', summary: '끝', recommendations: [{ type: 'idle', detail: 'd', estSavingKrw: 1 }] });
  await web.next((m) => m.type === 'consultation' && m.consultation.status === 'done');
  // Nothing was applied, so the recommendation stays open.
  const rec = await one<{ status: string }>('SELECT status FROM recommendations WHERE consultation_id = ?', [consultationId]);
  assert.equal(rec?.status, 'open');
  const row = await one<{ exit_code: number | null }>('SELECT exit_code FROM tool_calls WHERE id = ?', [call.id]);
  assert.equal(row?.exit_code, null);

  agent.send({ type: 'consultation_status', consultationId, status: 'running', recommendations: [{ type: 'idle', detail: 'dup', estSavingKrw: 1 }] });
  agent.send({ type: 'consultation_status', consultationId, status: 'done', recommendations: [{ type: 'idle', detail: 'dup', estSavingKrw: 1 }] });
  agent.send(metric());
  await web.next((m) => m.type === 'metric');
  const status = await one<{ status: string }>('SELECT status FROM consultations WHERE id = ?', [consultationId]);
  assert.equal(status?.status, 'done');
  const count = await one<{ n: number }>('SELECT COUNT(*) AS n FROM recommendations WHERE consultation_id = ?', [consultationId]);
  assert.equal(count?.n, 1);
  for (const peer of [agent, web]) await peer.close();
});

test('a newer agent connection replaces the old one and stays online', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const first = await connectAgent(app.wsBase, agentToken);
  const closed = new Promise((resolve) => first.ws.once('close', resolve));
  const second = await connectAgent(app.wsBase, agentToken);
  await closed;
  assert.equal((await client.req('GET', `/api/servers/${server.id}`)).body.online, true);
  await second.close();
});

test('deleting a server drops its agent and revokes the token', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const agent = await connectAgent(app.wsBase, agentToken);
  const closed = new Promise((resolve) => agent.ws.once('close', resolve));
  assert.equal((await client.req('DELETE', `/api/servers/${server.id}`)).status, 204);
  await closed;
  await rejects(connectAgent(app.wsBase, agentToken), 401);
});

test('executing a recommendation applies it only when a change really succeeded', async () => {
  const { client } = await signup(app.base);
  const { server, agentToken } = await addServer(client);
  const web = await connectWeb(app.wsBase, client.cookie);
  const agent = await connectAgent(app.wsBase, agentToken);
  await client.req('POST', `/api/servers/${server.id}/consultations`, { authMode: 'subscription', model: 'claude-opus-5-5' });
  await agent.next((m) => m.type === 'consultation_start');
  const insert = async () => {
    const [r] = await pool.query("INSERT INTO recommendations (server_id, source, type, detail) VALUES (?, 'rule', 'idle', '서버를 끕니다.')", [server.id]);
    return (r as { insertId: number }).insertId;
  };
  const status = async (id: number) => (await one<{ status: string; applied_at: Date | null }>('SELECT status, applied_at FROM recommendations WHERE id = ?', [id]))!;

  // Nothing ran: the report may claim anything, the recommendation stays open.
  const untouched = await insert();
  const first = await client.req('POST', `/api/recommendations/${untouched}/execute`);
  assert.equal(first.status, 201);
  const start = await agent.next((m) => m.type === 'consultation_start' && m.recommendationId === untouched);
  assert.equal(start.task, '서버를 끕니다.');
  assert.equal(start.authMode, 'subscription');
  assert.equal(start.model, 'claude-opus-5-5');
  agent.send({ type: 'consultation_status', consultationId: first.body.id, status: 'done', summary: '했습니다.', recommendationId: untouched });
  await web.next((m) => m.type === 'consultation' && m.consultation.id === first.body.id && m.consultation.status === 'done');
  assert.equal((await status(untouched)).status, 'open');

  // A change that ran with no human gate counts, and is linked for the savings report.
  const applied = await insert();
  const second = await client.req('POST', `/api/recommendations/${applied}/execute`);
  await agent.next((m) => m.type === 'consultation_start' && m.recommendationId === applied);
  agent.send(toolCall(second.body.id, 'run-1', { tier: 'approve', decision: 'auto' }));
  agent.send({ type: 'tool_result', requestId: 'run-1', exitCode: 0 });
  await web.next((m) => m.type === 'tool_call' && m.toolCall.exitCode === 0);
  agent.send({ type: 'consultation_status', consultationId: second.body.id, status: 'done', summary: '껐습니다.', recommendationId: applied });
  await web.next((m) => m.type === 'consultation' && m.consultation.id === second.body.id && m.consultation.status === 'done');
  const row = await status(applied);
  assert.equal(row.status, 'applied');
  assert.ok(row.applied_at);
  assert.equal((await client.req('POST', `/api/recommendations/${applied}/unapply`)).body.error.code, 'has_tool_calls');
  assert.equal((await client.req('POST', `/api/recommendations/${applied}/execute`)).status, 409);

  await agent.close();
  await web.close();
});
