// Handles messages from a connected agent. Each one is untrusted input bound to ctx.serverId.
import { one, rows, run, tx } from './db.js';
import { locate } from './geo.js';
import { broadcast } from './hub.js';
import { isNumber, isObject, isText } from './http.js';
import { getConsultation, getToolCall, type ToolCallRow } from './models.js';
import { pushStream, type StreamEntry } from './stream.js';
import { forget, ingestDecision, isTracked, settle, track } from './toolCalls.js';

export type AgentContext = { serverId: number; userId: number; ip?: string | null };
type Message = Record<string, unknown>;

const MAX_PROCESSES = 200;
const MAX_RECOMMENDATIONS = 20;
const MAX_FUTURE_SKEW_MS = 5 * 60_000;
export const RAW_RETENTION_MS = 7 * 24 * 3_600_000;
const MAX_TEXT = 60_000;
const TEXT_BYTES = 65_535; // a TEXT column holds bytes, and Hangul takes 3 per character
const LIVE_MS = 60_000; // older samples are a backlog from an outage, not news for an open page
const MAX_STREAM_TEXT = 8_000;
const STREAM_KINDS = ['text', 'command', 'output'];

const isInt32 = (v: unknown): v is number => Number.isInteger(v) && isNumber(v, -2147483648, 2147483647);
const isId = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) > 0;

const encoder = new TextEncoder();
const fitsText = (v: unknown): v is string => isText(v, MAX_TEXT) && Buffer.byteLength(v) <= TEXT_BYTES;
/** Cuts at a character boundary so the result fits a TEXT column. */
function clipText(v: string): string {
  const { read } = encoder.encodeInto(v, new Uint8Array(TEXT_BYTES));
  return v.slice(0, read);
}

const ownsConsultation = (ctx: AgentContext, id: number) =>
  one('SELECT id FROM consultations WHERE id = ? AND server_id = ?', [id, ctx.serverId]);

function isProcess(p: unknown): p is { pid: number; name: string; cpuPct: number; watts: number } {
  return (
    isObject(p) &&
    Number.isInteger(p.pid) &&
    isNumber(p.pid, 0, 4294967295) &&
    isText(p.name, 4096) &&
    isNumber(p.cpuPct, 0, 9999.99) &&
    isNumber(p.watts, 0, 999999.99)
  );
}

const TOP_PROCESSES = 10;

async function onMetrics(ctx: AgentContext, m: Message): Promise<void> {
  const ts = new Date(typeof m.ts === 'string' ? m.ts : NaN);
  const age = Date.now() - ts.getTime();
  // Anything past retention would land in an hour the rollup already closed.
  if (!(age < RAW_RETENTION_MS && age > -MAX_FUTURE_SKEW_MS)) return;
  const { cpuPct, memPct, watts, isEstimated, processes } = m;
  if (!isNumber(cpuPct, 0, 100) || !isNumber(memPct, 0, 100) || !isNumber(watts, 0, 999999.99)) return;
  if (typeof isEstimated !== 'boolean') return;
  if (!Array.isArray(processes) || processes.length > MAX_PROCESSES || !processes.every(isProcess)) return;

  await tx(async (c) => {
    // IGNORE: an agent re-sending a sample after a reconnect is not an error.
    await run(
      'INSERT IGNORE INTO metrics (server_id, ts, cpu_pct, mem_pct, watts, is_estimated) VALUES (?, ?, ?, ?, ?, ?)',
      [ctx.serverId, ts, cpuPct, memPct, watts, isEstimated],
      c,
    );
    if (processes.length) {
      await run(
        'INSERT IGNORE INTO process_samples (server_id, ts, pid, name, cpu_pct, watts) VALUES ?',
        [processes.map((p) => [ctx.serverId, ts, p.pid, p.name.slice(0, 255), p.cpuPct, p.watts])],
        c,
      );
    }
    await run('UPDATE servers SET last_seen_at = NOW() WHERE id = ?', [ctx.serverId], c);
  });
  if (age > LIVE_MS) return;
  broadcast(ctx.userId, {
    type: 'metric',
    serverId: ctx.serverId,
    metric: { ts: ts.toISOString(), cpuPct, memPct, watts, isEstimated },
    // Same shape as GET /processes, so an open page needs no request per sample.
    processes: [...(processes as { pid: number; name: string; cpuPct: number; watts: number }[])]
      .sort((a, b) => b.watts - a.watts)
      .slice(0, TOP_PROCESSES)
      .map((p) => ({ ts: ts.toISOString(), pid: p.pid, name: p.name.slice(0, 255), cpuPct: p.cpuPct, watts: p.watts })),
  });
}

async function onToolCall(ctx: AgentContext, m: Message): Promise<void> {
  const { consultationId, requestId, command, tier, decision, undoCommand } = m;
  if (!isId(consultationId) || !isText(requestId, 255) || !fitsText(command)) return;
  if (tier !== 'auto' && tier !== 'approve' && tier !== 'deny') return;
  if (decision !== 'auto' && decision !== 'pending' && decision !== 'blocked') return;
  if (isTracked(ctx.serverId, requestId) || !(await ownsConsultation(ctx, consultationId))) return;

  const stored = ingestDecision(tier, decision);
  // IGNORE: the agent re-sends queued records after a reconnect, and the unique key catches a repeat.
  const { insertId, affectedRows } = await run(
    `INSERT IGNORE INTO tool_calls (consultation_id, request_id, command, tier, decision, undo_command, approved_at)
     VALUES (?, ?, ?, ?, ?, ?, IF(?, NOW(), NULL))`,
    // A bad undoCommand only costs the undo button; the call itself must stay on record.
    // An approve-tier call reported as auto runs now, so this is also its applied_at.
    [consultationId, requestId, command, tier, stored, fitsText(undoCommand) ? undoCommand : null, tier === 'approve' && stored === 'auto'],
  );
  if (!affectedRows) return;
  if (stored !== 'blocked') {
    track({ ...ctx, requestId, toolCallId: insertId, consultationId }, stored === 'pending');
  }
  broadcast(ctx.userId, { type: 'tool_call', toolCall: await getToolCall(insertId) });
}

async function onToolResult(ctx: AgentContext, m: Message): Promise<void> {
  const { requestId, exitCode } = m;
  if (!isText(requestId, 255) || (exitCode !== null && !isInt32(exitCode))) return;
  // After a backend restart the call is no longer tracked, but its row still has the request id.
  const entry =
    settle(ctx.serverId, requestId) ??
    (await one<{ toolCallId: number }>(
      `SELECT t.id AS toolCallId FROM tool_calls t JOIN consultations c ON c.id = t.consultation_id
       WHERE c.server_id = ? AND t.request_id = ?`,
      [ctx.serverId, requestId],
    ));
  if (!entry) return;
  // No exit code on a pending call: the agent gave up waiting (timeout or lost link) and treats it as denied.
  // settle() has already stopped the expiry timer, so nothing else would close it.
  const { affectedRows } = exitCode === null
    ? await run("UPDATE tool_calls SET decision = 'denied' WHERE id = ? AND decision = 'pending'", [entry.toolCallId])
    : // A denied call never ran, so whatever the agent reports for it is not a result.
      await run(
        "UPDATE tool_calls SET exit_code = ? WHERE id = ? AND decision IN ('auto', 'approved') AND exit_code IS NULL",
        [exitCode, entry.toolCallId],
      );
  if (affectedRows) broadcast(ctx.userId, { type: 'tool_call', toolCall: await getToolCall(entry.toolCallId) });
}

async function onUndoResult(ctx: AgentContext, m: Message): Promise<void> {
  const { toolCallId, exitCode } = m;
  if (!isId(toolCallId) || !isInt32(exitCode)) return;
  const { affectedRows } = await run(
    `UPDATE tool_calls t JOIN consultations c ON c.id = t.consultation_id
     SET t.exit_code = ? WHERE t.id = ? AND c.server_id = ? AND t.undo_of IS NOT NULL AND t.exit_code IS NULL`,
    [exitCode, toolCallId, ctx.serverId],
  );
  if (!affectedRows) return;
  if (exitCode === 0) {
    // Reopen only when nothing the recommendation changed is still in place.
    await run(
      `UPDATE recommendations r JOIN tool_calls t ON t.recommendation_id = r.id
       SET r.status = 'open', r.applied_at = NULL
       WHERE t.id = ? AND NOT EXISTS (
         SELECT 1 FROM tool_calls k
         LEFT JOIN tool_calls u ON u.undo_of = k.id AND u.exit_code = 0
         WHERE k.recommendation_id = r.id AND k.undo_of IS NULL AND k.exit_code = 0
           AND k.decision IN ('auto', 'approved') AND u.id IS NULL
       )`,
      [toolCallId],
    );
  }
  broadcast(ctx.userId, { type: 'tool_call', toolCall: await getToolCall(toolCallId) });
}

type ReportedRecommendation = { type: string; detail: string; estSavingKrw: number };

function isRecommendation(r: unknown): r is ReportedRecommendation {
  return isObject(r) && isText(r.type, 40) && fitsText(r.detail) && isNumber(r.estSavingKrw, 0, 2147483647);
}

const LEVELS = ['good', 'fair', 'warning', 'critical'];
const MAX_FEEDBACK = 5;
const MAX_FIXES = 8;
const MAX_LINE = 500;

const textList = (v: unknown, max: number) =>
  Array.isArray(v) ? JSON.stringify(v.filter((s): s is string => typeof s === 'string' && s !== '').slice(0, max).map((s) => s.slice(0, MAX_LINE))) : null;

async function onConsultationStatus(ctx: AgentContext, m: Message): Promise<void> {
  const { consultationId, status, summary, recommendations, level, feedback, fixes, recommendationId } = m;
  if (!isId(consultationId) || (status !== 'running' && status !== 'done' && status !== 'failed')) return;
  // A bad optional field must not leave the consultation stuck: status is what matters here.
  const text = typeof summary === 'string' ? clipText(summary.slice(0, MAX_TEXT)) : null;
  const reported = Array.isArray(recommendations)
    ? recommendations.filter(isRecommendation).slice(0, MAX_RECOMMENDATIONS)
    : [];

  const linkedCalls = await tx(async (c) => {
    const { affectedRows } = await run(
      `UPDATE consultations SET status = ?, summary = COALESCE(?, summary), server_level = ?, feedback = ?, fixes = ?
       WHERE id = ? AND server_id = ? AND status NOT IN ('done', 'failed')`,
      [
        status,
        text,
        typeof level === 'string' && LEVELS.includes(level) ? level : null,
        textList(feedback, MAX_FEEDBACK),
        textList(fixes, MAX_FIXES),
        consultationId,
        ctx.serverId,
      ],
      c,
    );
    if (!affectedRows) return null;
    if (status !== 'done') return [];

    const ids: number[] = [];
    for (const r of reported) {
      const { insertId } = await run(
        `INSERT INTO recommendations (server_id, consultation_id, source, type, detail, est_saving_krw) VALUES (?, ?, 'ai', ?, ?, ?)`,
        [ctx.serverId, consultationId, r.type, r.detail, Math.round(r.estSavingKrw)],
        c,
      );
      ids.push(insertId);
    }
    // Calls that took effect and were not undone.
    const applied = await rows<Pick<ToolCallRow, 'id' | 'approved_at'>>(
      `SELECT t.id, t.approved_at FROM tool_calls t
       LEFT JOIN tool_calls u ON u.undo_of = t.id AND u.exit_code = 0
       WHERE t.consultation_id = ? AND t.tier = 'approve' AND t.decision IN ('auto', 'approved') AND t.exit_code = 0
         AND t.undo_of IS NULL AND u.id IS NULL`,
      [consultationId],
      c,
    );
    // The owner asked for this one: it takes the effect, and nothing else is credited.
    const target = isId(recommendationId)
      ? await one<{ id: number }>("SELECT id FROM recommendations WHERE id = ? AND server_id = ? AND status = 'open'", [recommendationId, ctx.serverId], c)
      : undefined;
    const first = target?.id ?? ids[0];
    if (first === undefined || applied.length === 0) return [];
    // ponytail: api.md does not say which recommendation a call served. The agent changes one thing
    // at a time, so the lead recommendation takes the measured effect and the rest stay open; marking
    // them all would count one power drop several times. Replace once tool_call carries the link.
    const appliedAt = new Date(Math.max(...applied.map((t) => t.approved_at!.getTime())));
    await run("UPDATE recommendations SET status = 'applied', applied_at = ? WHERE id = ?", [appliedAt, first], c);
    await run('UPDATE tool_calls SET recommendation_id = ? WHERE id IN (?)', [first, applied.map((t) => t.id)], c);
    return applied.map((t) => t.id);
  });
  if (linkedCalls === null) return;

  if (status !== 'running') forget(consultationId);
  for (const id of linkedCalls) broadcast(ctx.userId, { type: 'tool_call', toolCall: await getToolCall(id) });
  broadcast(ctx.userId, { type: 'consultation', consultation: await getConsultation(consultationId) });
}

async function onConsultationStream(ctx: AgentContext, m: Message): Promise<void> {
  const { consultationId, kind, text } = m;
  if (!isId(consultationId) || !STREAM_KINDS.includes(kind as string) || !isText(text, MAX_STREAM_TEXT)) return;
  const live = await one(
    "SELECT id FROM consultations WHERE id = ? AND server_id = ? AND status IN ('requested', 'running')",
    [consultationId, ctx.serverId],
  );
  if (!live) return;
  const entry = pushStream(consultationId, kind as StreamEntry['kind'], text);
  broadcast(ctx.userId, { type: 'consultation_stream', consultationId, entry });
}

// One lookup per server and address for the life of the process; a failure leaves the old place.
const placed = new Map<number, string>();
async function place(ctx: AgentContext): Promise<void> {
  if (!ctx.ip || placed.get(ctx.serverId) === ctx.ip) return;
  placed.set(ctx.serverId, ctx.ip);
  try {
    const found = await locate(ctx.ip);
    if (found) {
      await run('UPDATE servers SET latitude = ?, longitude = ?, location = ? WHERE id = ?', [found.lat, found.lon, found.label, ctx.serverId]);
    }
  } catch (err) {
    placed.delete(ctx.serverId);
    console.error(`locate server ${ctx.serverId}:`, err instanceof Error ? err.message : err);
  }
}

export async function handleAgentMessage(ctx: AgentContext, raw: string): Promise<void> {
  let m: unknown;
  try {
    m = JSON.parse(raw);
  } catch {
    return;
  }
  if (!isObject(m)) return;
  switch (m.type) {
    case 'hello':
      if (isText(m.agentVersion, 64) && isText(m.hostname, 255) && isText(m.os, 64)) {
        await run('UPDATE servers SET last_seen_at = NOW() WHERE id = ?', [ctx.serverId]);
        void place(ctx);
      }
      return;
    case 'metrics':
      return onMetrics(ctx, m);
    case 'tool_call':
      return onToolCall(ctx, m);
    case 'tool_result':
      return onToolResult(ctx, m);
    case 'consultation_status':
      return onConsultationStatus(ctx, m);
    case 'consultation_stream':
      return onConsultationStream(ctx, m);
    case 'undo_result':
      return onUndoResult(ctx, m);
  }
}
