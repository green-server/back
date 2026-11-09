// The approval state machine. The guards are pure; decide() and undo() apply them under a row lock.
import type { PoolConnection } from 'mysql2/promise';
import { one, rows, run, tx } from './db.js';
import { grantFor } from './grants.js';
import { broadcast, isOnline, sendToAgent } from './hub.js';
import { agentOffline, ApiError, notFound } from './http.js';
import { getToolCall, type ToolCallRow } from './models.js';

/** api.md: the agent treats an undecided call as denied after this long. */
const APPROVAL_TIMEOUT_MS = 10 * 60_000;

export type Decision = 'approved' | 'denied';
type Guard = { code: string; message: string } | null;

export function decisionGuard(call: Pick<ToolCallRow, 'tier' | 'decision'>, next: Decision): Guard {
  if (call.tier === 'deny' && next === 'approved') {
    return { code: 'tier_denied', message: '항상 금지된 명령은 승인할 수 없습니다.' };
  }
  if (call.decision !== 'pending') return { code: 'not_pending', message: '승인을 기다리는 호출이 아닙니다.' };
  return null;
}

export function undoGuard(
  call: Pick<ToolCallRow, 'decision' | 'exit_code' | 'undo_command' | 'undo_of'>,
  undos: Pick<ToolCallRow, 'exit_code'>[],
): Guard {
  const ran = call.decision === 'auto' || call.decision === 'approved';
  if (!call.undo_command || call.undo_of !== null || !ran || call.exit_code !== 0) {
    return { code: 'not_undoable', message: '되돌릴 수 없는 호출입니다.' };
  }
  // A failed undo may be retried; one in flight or finished may not.
  if (undos.some((u) => u.exit_code === null || u.exit_code === 0)) {
    return { code: 'already_undone', message: '이미 되돌렸거나 되돌리는 중입니다.' };
  }
  return null;
}

/** Contract pairs pass through. Anything else, and every deny, is recorded as blocked. */
export function ingestDecision(
  tier: ToolCallRow['tier'],
  decision: 'auto' | 'pending' | 'blocked',
): ToolCallRow['decision'] {
  if (decision === 'blocked') return 'blocked';
  // Consultations run in auto mode: an approve-tier call arrives as already running.
  const known = tier === 'approve' || (tier === 'auto' && decision === 'auto');
  return known ? decision : 'blocked';
}

type Tracked = {
  serverId: number;
  userId: number;
  requestId: string;
  toolCallId: number;
  consultationId: number;
  timer?: NodeJS.Timeout;
};

// Live calls by request id. tool_calls.request_id keeps the link across a restart; this adds the timer.
const tracked = new Map<string, Tracked>();
const key = (serverId: number, requestId: string) => `${serverId}:${requestId}`;

export const isTracked = (serverId: number, requestId: string) => tracked.has(key(serverId, requestId));

export function track(entry: Tracked, pending: boolean): void {
  if (pending) {
    entry.timer = setTimeout(() => expire(entry).catch(console.error), APPROVAL_TIMEOUT_MS);
    entry.timer.unref();
  }
  tracked.set(key(entry.serverId, entry.requestId), entry);
}

/** Resolves a tool_result to its call and stops tracking it. */
export function settle(serverId: number, requestId: string): Tracked | undefined {
  const k = key(serverId, requestId);
  const entry = tracked.get(k);
  if (entry) clearTimeout(entry.timer);
  tracked.delete(k);
  return entry;
}

/** Drops entries of a finished consultation. Calls still awaiting approval keep their timeout. */
export function forget(consultationId: number): void {
  for (const [k, entry] of tracked) {
    if (entry.consultationId === consultationId && !entry.timer) tracked.delete(k);
  }
}

async function expire(entry: Tracked): Promise<void> {
  settle(entry.serverId, entry.requestId);
  const { affectedRows } = await run("UPDATE tool_calls SET decision = 'denied' WHERE id = ? AND decision = 'pending'", [entry.toolCallId]);
  if (affectedRows) broadcast(entry.userId, { type: 'tool_call', toolCall: await getToolCall(entry.toolCallId) });
}

/** After a restart nothing can relay these decisions, and the agent has already given up or will. */
export const denyStalePending = () => run("UPDATE tool_calls SET decision = 'denied' WHERE decision = 'pending'");

function lockOwned(c: PoolConnection, userId: number, id: number) {
  return one<ToolCallRow & { server_id: number }>(
    `SELECT t.*, c.server_id FROM tool_calls t
     JOIN consultations c ON c.id = t.consultation_id
     JOIN servers s ON s.id = c.server_id
     WHERE t.id = ? AND s.user_id = ? FOR UPDATE OF t`,
    [id, userId],
    c,
  );
}

const conflict = (guard: NonNullable<Guard>) => new ApiError(409, guard.code, guard.message);

export async function decide(userId: number, id: number, decision: Decision) {
  const { entry, command } = await tx(async (c) => {
    const call = await lockOwned(c, userId, id);
    if (!call) throw notFound();
    const guard = decisionGuard(call, decision);
    if (guard) throw conflict(guard);
    const entry = [...tracked.values()].find((e) => e.toolCallId === id);
    if (!entry || !isOnline(call.server_id)) throw agentOffline();
    await run(
      `UPDATE tool_calls SET decision = ?, approved_at = IF(? = 'approved', NOW(), NULL) WHERE id = ?`,
      [decision, decision, id],
      c,
    );
    return { entry, command: call.command };
  });
  clearTimeout(entry.timer);
  delete entry.timer;
  const grant = decision === 'approved' ? grantFor(entry.serverId, command) : undefined;
  if (!sendToAgent(entry.serverId, { type: 'decision', requestId: entry.requestId, decision, ...(grant && { grant }) })) {
    // The link dropped after the check: the agent never heard, so the call is still waiting.
    await run("UPDATE tool_calls SET decision = 'pending', approved_at = NULL WHERE id = ?", [id]);
    track(entry, true);
    throw agentOffline();
  }
  const toolCall = await getToolCall(id);
  broadcast(userId, { type: 'tool_call', toolCall });
  return toolCall;
}

export async function undo(userId: number, id: number) {
  const { serverId, undoId, command } = await tx(async (c) => {
    const call = await lockOwned(c, userId, id);
    if (!call) throw notFound();
    const undos = await rows<ToolCallRow>('SELECT exit_code FROM tool_calls WHERE undo_of = ?', [id], c);
    const guard = undoGuard(call, undos);
    if (guard) throw conflict(guard);
    if (!isOnline(call.server_id)) throw agentOffline();
    const { insertId } = await run(
      `INSERT INTO tool_calls (consultation_id, recommendation_id, command, tier, decision, approved_at, undo_of)
       VALUES (?, ?, ?, 'approve', 'approved', NOW(), ?)`,
      [call.consultation_id, call.recommendation_id, call.undo_command, id],
      c,
    );
    return { serverId: call.server_id, undoId: insertId, command: call.undo_command! };
  });
  const grant = grantFor(serverId, command);
  if (!sendToAgent(serverId, { type: 'undo', toolCallId: undoId, command, ...(grant && { grant }) })) {
    // Nothing ran, so the row must not count as an undo in flight and block a retry.
    await run('DELETE FROM tool_calls WHERE id = ?', [undoId]);
    throw agentOffline();
  }
  const toolCall = await getToolCall(undoId);
  broadcast(userId, { type: 'tool_call', toolCall });
  return toolCall;
}

