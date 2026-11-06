import { randomBytes } from 'node:crypto';
import { Router, type Request, type Response } from 'express';
import { clearSession, hashPassword, requireAuth, setSession, sha256, verifyPassword, type UserRow } from './auth.js';
import { one, rows, run } from './db.js';
import { agentOffline, ApiError, invalid, isNumber, isObject, isText, notFound, parseId } from './http.js';
import { broadcast, closeAgent, closeWebClients, isOnline, sendToAgent } from './hub.js';
import { streamOf } from './stream.js';
import {
  getConsultation,
  iso,
  serverSummaries,
  toConsultation,
  toRecommendation,
  toServer,
  toToolCall,
  toUser,
  type ConsultationRow,
  type RecommendationRow,
  type ServerRow,
  type ToolCallRow,
} from './models.js';
import { grantPublicKey } from './grants.js';
import { savingsReport } from './savings.js';
import { decide, undo } from './toolCalls.js';

/** Turn limit per consultation; a run spends the owner's own Claude quota. */
const MAX_TURNS = 30;

const MODELS = ['claude-fable-5-1', 'claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'];
const DEFAULT_MODEL = 'claude-sonnet-5-5';

const MIN_PASSWORD = 8;
const MAX_PASSWORD = 128; // bounds the scrypt work an unauthenticated request can demand
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const KINDS = ['baremetal', 'home_pc', 'cloud_vm'];
const RATE_PLANS = ['home_tiered', 'cloud_hourly'];
const AUTH_MODES = ['subscription', 'api_key'];
const MAX_HOURLY_KRW = 99_999_999.99; // DECIMAL(10,2)
const MAX_HOUSEHOLD_KWH = 4_294_967_295; // INT UNSIGNED

/** [window seconds, bucket seconds]. 7 days of 10-second samples would be 60,000 rows per chart. */
const METRIC_RANGES: Record<string, [number, number]> = {
  '1h': [3600, 10],
  '24h': [86_400, 60],
  '7d': [604_800, 600],
};

function body(req: Request): Record<string, unknown> {
  if (!isObject(req.body)) throw invalid('요청 본문이 올바르지 않습니다.');
  return req.body;
}

const isPassword = (v: unknown): v is string =>
  typeof v === 'string' && v.length >= MIN_PASSWORD && v.length <= MAX_PASSWORD;

function pathId(req: Request): number {
  const id = parseId(req.params.id);
  if (id === null) throw notFound();
  return id;
}

async function ownedServer(req: Request): Promise<ServerRow> {
  const server = await one<ServerRow>('SELECT * FROM servers WHERE id = ? AND user_id = ?', [pathId(req), req.user.id]);
  if (!server) throw notFound();
  return server;
}

/** Validates a full input, or a partial one merged over the stored row. */
function serverColumns(input: Record<string, unknown>, current?: ServerRow): unknown[] {
  const field = (key: string, fallback: unknown) => (input[key] === undefined ? fallback : input[key]);
  const name = field('name', current?.name);
  const kind = field('kind', current?.kind);
  const ratePlan = field('ratePlan', current?.rate_plan);
  const hourlyKrw = field('hourlyKrw', current?.hourly_krw ?? null);
  const householdKwh = field('householdKwh', current?.household_kwh ?? 0);

  if (!isText(name, 100)) throw invalid('서버 이름은 1~100자여야 합니다.');
  if (typeof kind !== 'string' || !KINDS.includes(kind)) throw invalid('kind가 올바르지 않습니다.');
  if (typeof ratePlan !== 'string' || !RATE_PLANS.includes(ratePlan)) throw invalid('ratePlan이 올바르지 않습니다.');
  if (hourlyKrw !== null && !isNumber(hourlyKrw, 0, MAX_HOURLY_KRW)) throw invalid('hourlyKrw가 올바르지 않습니다.');
  if (ratePlan === 'cloud_hourly' && hourlyKrw === null) throw invalid('cloud_hourly 요금제는 hourlyKrw가 필요합니다.');
  if (!Number.isInteger(householdKwh) || !isNumber(householdKwh, 0, MAX_HOUSEHOLD_KWH)) {
    throw invalid('householdKwh는 0 이상의 정수여야 합니다.');
  }
  return [name.trim(), kind, kind === 'cloud_vm' ? 'estimated' : 'measured', ratePlan, hourlyKrw, householdKwh];
}

export const api = Router();

api.post('/auth/signup', async (req, res) => {
  const { email, name, password } = body(req);
  if (!isText(email, 255) || !EMAIL.test(email.trim())) throw invalid('이메일이 올바르지 않습니다.');
  if (!isText(name, 50)) throw invalid('이름은 1~50자여야 합니다.');
  if (!isPassword(password)) throw invalid(`비밀번호는 ${MIN_PASSWORD}~${MAX_PASSWORD}자여야 합니다.`);
  const hash = await hashPassword(password);
  try {
    const { insertId } = await run('INSERT INTO users (email, name, password_hash) VALUES (?, ?, ?)', [
      email.trim().toLowerCase(),
      name.trim(),
      hash,
    ]);
    setSession(res, insertId);
    const user = await one<UserRow>('SELECT id, email, name, created_at FROM users WHERE id = ?', [insertId]);
    res.status(201).json(toUser(user!));
  } catch (err) {
    if ((err as { code?: string }).code === 'ER_DUP_ENTRY') {
      throw new ApiError(409, 'email_taken', '이미 가입된 이메일입니다.');
    }
    throw err;
  }
});

api.post('/auth/login', async (req, res) => {
  const { email, password } = body(req);
  if (!isText(email, 255) || typeof password !== 'string' || password.length > MAX_PASSWORD) {
    throw invalid('이메일과 비밀번호를 입력해 주세요.');
  }
  const user = await one<UserRow & { password_hash: string }>('SELECT * FROM users WHERE email = ?', [email.trim().toLowerCase()]);
  if (!(await verifyPassword(password, user?.password_hash)) || !user) {
    throw new ApiError(401, 'invalid_credentials', '이메일 또는 비밀번호가 올바르지 않습니다.');
  }
  setSession(res, user.id);
  res.json(toUser(user));
});

api.post('/auth/logout', (_req, res) => {
  clearSession(res);
  res.status(204).end();
});

// Public on purpose: the root helper installer pins this key.
api.get('/grant-public-key', (_req, res) => {
  res.json({ publicKey: grantPublicKey });
});

api.use(requireAuth);

api.get('/me', (req, res) => {
  res.json(toUser(req.user));
});

api.patch('/me', async (req, res) => {
  const { name, password } = body(req);
  if (name !== undefined && !isText(name, 50)) throw invalid('이름은 1~50자여야 합니다.');
  if (password !== undefined && !isPassword(password)) throw invalid(`비밀번호는 ${MIN_PASSWORD}~${MAX_PASSWORD}자여야 합니다.`);
  if (name !== undefined) await run('UPDATE users SET name = ? WHERE id = ?', [name.trim(), req.user.id]);
  if (password !== undefined) await run('UPDATE users SET password_hash = ? WHERE id = ?', [await hashPassword(password), req.user.id]);
  res.json(toUser({ ...req.user, name: name?.trim() ?? req.user.name }));
});

api.delete('/me', async (req, res) => {
  const servers = await rows<{ id: number }>('SELECT id FROM servers WHERE user_id = ?', [req.user.id]);
  await run('DELETE FROM users WHERE id = ?', [req.user.id]);
  for (const { id } of servers) closeAgent(id);
  closeWebClients(req.user.id);
  clearSession(res);
  res.status(204).end();
});

api.get('/servers', async (req, res) => {
  res.json(await serverSummaries(req.user.id, isOnline));
});

api.post('/servers', async (req, res) => {
  const columns = serverColumns(body(req));
  const agentToken = randomBytes(32).toString('base64url');
  const { insertId } = await run(
    `INSERT INTO servers (name, kind, power_source, rate_plan, hourly_krw, household_kwh, user_id, agent_token_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [...columns, req.user.id, sha256(agentToken)],
  );
  const server = await one<ServerRow>('SELECT * FROM servers WHERE id = ?', [insertId]);
  res.status(201).json({ server: toServer(server!), agentToken });
});

api.get('/servers/:id', async (req, res) => {
  const { id } = await ownedServer(req);
  const [summary] = await serverSummaries(req.user.id, isOnline, id);
  if (!summary) throw notFound();
  res.json(summary);
});

api.patch('/servers/:id', async (req, res) => {
  const current = await ownedServer(req);
  await run(
    `UPDATE servers SET name = ?, kind = ?, power_source = ?, rate_plan = ?, hourly_krw = ?, household_kwh = ?
     WHERE id = ?`,
    [...serverColumns(body(req), current), current.id],
  );
  res.json(toServer(await ownedServer(req)));
});

api.delete('/servers/:id', async (req, res) => {
  const { id } = await ownedServer(req);
  await run('DELETE FROM servers WHERE id = ?', [id]);
  closeAgent(id);
  res.status(204).end();
});

api.get('/servers/:id/metrics', async (req, res) => {
  const { id } = await ownedServer(req);
  const range = METRIC_RANGES[String(req.query.range ?? '1h')];
  if (!range) throw invalid('range는 1h, 24h, 7d 중 하나여야 합니다.');
  const [windowSec, bucketSec] = range;
  const found = await rows<{ ts: Date; cpu_pct: number; mem_pct: number; watts: number; is_estimated: number }>(
    `SELECT FROM_UNIXTIME(FLOOR(UNIX_TIMESTAMP(ts) / ?) * ?) AS ts, ROUND(AVG(cpu_pct), 2) AS cpu_pct,
            ROUND(AVG(mem_pct), 2) AS mem_pct, ROUND(AVG(watts), 2) AS watts, MAX(is_estimated) AS is_estimated
     FROM metrics WHERE server_id = ? AND metrics.ts >= ? GROUP BY 1 ORDER BY 1`,
    [bucketSec, bucketSec, id, new Date(Date.now() - windowSec * 1000)],
  );
  res.json(
    found.map((m) => ({ ts: iso(m.ts), cpuPct: m.cpu_pct, memPct: m.mem_pct, watts: m.watts, isEstimated: Boolean(m.is_estimated) })),
  );
});

api.get('/servers/:id/processes', async (req, res) => {
  const { id } = await ownedServer(req);
  const found = await rows<{ ts: Date; pid: number; name: string; cpu_pct: number; watts: number }>(
    `SELECT p.ts, p.pid, p.name, p.cpu_pct, p.watts
     FROM process_samples p
     JOIN servers s ON s.id = p.server_id
     WHERE s.id = ? AND p.ts = (SELECT MAX(ts) FROM process_samples WHERE server_id = s.id)
     ORDER BY p.watts DESC LIMIT 10`,
    [id],
  );
  res.json(found.map((p) => ({ ts: iso(p.ts), pid: p.pid, name: p.name, cpuPct: p.cpu_pct, watts: p.watts })));
});

api.get('/servers/:id/recommendations', async (req, res) => {
  const { id } = await ownedServer(req);
  const found = await rows<RecommendationRow>('SELECT * FROM recommendations WHERE server_id = ? ORDER BY id DESC', [id]);
  res.json(found.map(toRecommendation));
});

const RECOMMENDATION_SELECT = `SELECT r.* FROM recommendations r JOIN servers s ON s.id = r.server_id WHERE r.id = ? AND s.user_id = ?`;

async function ownedRecommendation(req: Request) {
  const found = await one<RecommendationRow>(RECOMMENDATION_SELECT, [pathId(req), req.user.id]);
  if (!found) throw notFound();
  return found;
}

async function closeRecommendation(req: Request, res: Response, assignment: string) {
  const found = await ownedRecommendation(req);
  if (found.status !== 'open') throw new ApiError(409, 'not_open', '열려 있는 추천이 아닙니다.');
  await run(`UPDATE recommendations SET ${assignment} WHERE id = ? AND status = 'open'`, [found.id]);
  res.json(toRecommendation(await ownedRecommendation(req)));
}

api.post('/recommendations/:id/dismiss', (req, res) => closeRecommendation(req, res, "status = 'dismissed'"));

// applied_at is what the savings report compares before and after.
api.post('/recommendations/:id/apply', (req, res) => closeRecommendation(req, res, "status = 'applied', applied_at = NOW()"));

api.post('/recommendations/:id/unapply', async (req, res) => {
  const found = await ownedRecommendation(req);
  if (found.status !== 'applied') throw new ApiError(409, 'not_applied', '적용된 추천이 아닙니다.');
  // Commands really ran for these: clearing the mark would hide a change that is still on the server.
  const calls = await rows<{ id: number }>('SELECT id FROM tool_calls WHERE recommendation_id = ? LIMIT 1', [found.id]);
  if (calls.length > 0) throw new ApiError(409, 'has_tool_calls', '실행 기록이 있는 조치입니다. 컨설팅 화면에서 되돌려 주세요.');
  await run("UPDATE recommendations SET status = 'open', applied_at = NULL WHERE id = ? AND status = 'applied'", [found.id]);
  res.json(toRecommendation(await ownedRecommendation(req)));
});

api.get('/servers/:id/consultations', async (req, res) => {
  const { id } = await ownedServer(req);
  const found = await rows<ConsultationRow>('SELECT * FROM consultations WHERE server_id = ? ORDER BY id DESC', [id]);
  res.json(found.map(toConsultation));
});

type Task = { task: string } & ({ recommendationId: number } | { readOnly: true });

async function startConsultation(userId: number, serverId: number, authMode: string, model: string, task?: Task) {
  if (!isOnline(serverId)) throw agentOffline();
  const { insertId } = await run('INSERT INTO consultations (server_id, auth_mode, model) VALUES (?, ?, ?)', [serverId, authMode, model]);
  if (!sendToAgent(serverId, { type: 'consultation_start', consultationId: insertId, authMode, model, maxTurns: MAX_TURNS, ...task })) {
    await run("UPDATE consultations SET status = 'failed' WHERE id = ?", [insertId]);
    throw agentOffline();
  }
  const consultation = await getConsultation(insertId);
  broadcast(userId, { type: 'consultation', consultation });
  return consultation;
}

api.post('/servers/:id/consultations', async (req, res) => {
  const { id } = await ownedServer(req);
  const { authMode, model = DEFAULT_MODEL } = body(req);
  if (typeof authMode !== 'string' || !AUTH_MODES.includes(authMode)) throw invalid('authMode가 올바르지 않습니다.');
  if (typeof model !== 'string' || !MODELS.includes(model)) throw invalid('model이 올바르지 않습니다.');
  res.status(201).json(await startConsultation(req.user.id, id, authMode, model));
});

// Runs the recommendation on the server. It uses the settings of the last consultation,
// because that auth mode is the one known to work there.
async function openRecommendationSettings(found: { status: string; server_id: number }) {
  if (found.status !== 'open') throw new ApiError(409, 'not_open', '열려 있는 추천이 아닙니다.');
  const last = await one<Pick<ConsultationRow, 'auth_mode' | 'model'>>(
    'SELECT auth_mode, model FROM consultations WHERE server_id = ? ORDER BY id DESC LIMIT 1',
    [found.server_id],
  );
  return last;
}

// What the owner read and agreed to is what runs.
async function planSteps(planConsultationId: unknown, serverId: number) {
  if (planConsultationId === undefined) return '';
  const id = parseId(String(planConsultationId));
  const plan = id === null ? undefined : await one<ConsultationRow>("SELECT * FROM consultations WHERE id = ? AND server_id = ? AND status = 'done'", [id, serverId]);
  if (!plan) throw invalid('계획을 찾을 수 없습니다.');
  const steps = toConsultation(plan).fixes.map((step: string, i: number) => `${i + 1}. ${step}`).join('\n');
  return steps && `\n\n서버 주인이 확인한 계획입니다. 이 순서를 따르세요.\n${steps}`;
}

api.post('/recommendations/:id/execute', async (req, res) => {
  const found = await ownedRecommendation(req);
  const last = await openRecommendationSettings(found);
  const task = { recommendationId: found.id, task: found.detail + (await planSteps(req.body?.planConsultationId, found.server_id)) };
  res.status(201).json(await startConsultation(req.user.id, found.server_id, last?.auth_mode ?? 'subscription', last?.model ?? DEFAULT_MODEL, task));
});

// A look at the real server before anything changes. The agent enforces read-only.
api.post('/recommendations/:id/plan', async (req, res) => {
  const found = await ownedRecommendation(req);
  const last = await openRecommendationSettings(found);
  const task = { readOnly: true as const, task: found.detail };
  res.status(201).json(await startConsultation(req.user.id, found.server_id, last?.auth_mode ?? 'subscription', last?.model ?? DEFAULT_MODEL, task));
});

api.get('/consultations/:id', async (req, res) => {
  const consultation = await one<ConsultationRow>(
    'SELECT c.* FROM consultations c JOIN servers s ON s.id = c.server_id WHERE c.id = ? AND s.user_id = ?',
    [pathId(req), req.user.id],
  );
  if (!consultation) throw notFound();
  const calls = await rows<ToolCallRow>('SELECT * FROM tool_calls WHERE consultation_id = ? ORDER BY id', [consultation.id]);
  res.json({ ...toConsultation(consultation), toolCalls: calls.map(toToolCall), stream: streamOf(consultation.id) });
});

api.post('/tool-calls/:id/decision', async (req, res) => {
  const id = pathId(req);
  const { decision } = body(req);
  if (decision !== 'approved' && decision !== 'denied') throw invalid('decision이 올바르지 않습니다.');
  res.json(await decide(req.user.id, id, decision));
});

api.post('/tool-calls/:id/undo', async (req, res) => {
  res.status(202).json(await undo(req.user.id, pathId(req)));
});

const ACTIVITY_LIMIT = 20;

api.get('/reports/activity', async (req, res) => {
  // LEFT JOIN: a server nothing was recommended for still belongs in the table, with zeros.
  const servers = await rows<{ id: number; name: string; total: number; open: string | null; applied: string | null; open_saving: string | null }>(
    `SELECT s.id, s.name, COUNT(r.id) AS total,
            SUM(r.status = 'open') AS open, SUM(r.status = 'applied') AS applied,
            SUM(CASE WHEN r.status = 'open' THEN r.est_saving_krw END) AS open_saving
     FROM servers s
     LEFT JOIN recommendations r ON r.server_id = s.id
     WHERE s.user_id = ?
     GROUP BY s.id, s.name
     ORDER BY s.id`,
    [req.user.id],
  );
  // INNER JOIN: a command only exists inside a consultation on a server, so the chain always matches.
  const calls = await rows<{ id: number; command: string; decision: ToolCallRow['decision']; exit_code: number | null; consultation_id: number; requested_at: Date; server_name: string }>(
    `SELECT t.id, t.command, t.decision, t.exit_code, c.id AS consultation_id, c.requested_at, s.name AS server_name
     FROM tool_calls t
     INNER JOIN consultations c ON c.id = t.consultation_id
     INNER JOIN servers s ON s.id = c.server_id
     WHERE s.user_id = ?
     ORDER BY t.id DESC
     LIMIT ?`,
    [req.user.id, ACTIVITY_LIMIT],
  );
  res.json({
    servers: servers.map((s) => ({
      serverId: s.id,
      serverName: s.name,
      total: Number(s.total),
      open: Number(s.open ?? 0),
      applied: Number(s.applied ?? 0),
      openSavingKrw: Number(s.open_saving ?? 0),
    })),
    calls: calls.map((c) => ({
      id: c.id,
      command: c.command,
      decision: c.decision,
      exitCode: c.exit_code,
      consultationId: c.consultation_id,
      requestedAt: c.requested_at.toISOString(),
      serverName: c.server_name,
    })),
  });
});

api.get('/reports/savings', async (req, res) => {
  let serverId: number | null = null;
  if (req.query.serverId !== undefined) {
    serverId = parseId(req.query.serverId);
    if (serverId === null) throw invalid('serverId가 올바르지 않습니다.');
    const owned = await one('SELECT id FROM servers WHERE id = ? AND user_id = ?', [serverId, req.user.id]);
    if (!owned) throw notFound();
  }
  res.json(await savingsReport(req.user.id, serverId));
});
