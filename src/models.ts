// Row shapes and their api.md JSON form.
import type { UserRow } from './auth.js';
import { one, rows } from './db.js';
import { kstMonth, monthlyCostKrw, projectKwh } from './fees.js';

/** The agent reports every 10 seconds, so each sample stands for 10 seconds of energy. */
export const METRIC_INTERVAL_SEC = 10;
const RECENT_WATTS_HOURS = 24;

export const iso = (d: Date | null) => (d ? d.toISOString() : null);

export const toUser = (u: UserRow) => ({ id: u.id, email: u.email, name: u.name, createdAt: iso(u.created_at) });

export type ServerRow = {
  id: number;
  user_id: number;
  name: string;
  kind: 'baremetal' | 'home_pc' | 'cloud_vm';
  power_source: 'measured' | 'estimated';
  rate_plan: 'home_tiered' | 'cloud_hourly';
  hourly_krw: number | null;
  household_kwh: number;
  last_seen_at: Date | null;
  created_at: Date;
};

export const toServer = (s: ServerRow) => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  ratePlan: s.rate_plan,
  hourlyKrw: s.hourly_krw,
  householdKwh: s.household_kwh,
  powerSource: s.power_source,
  lastSeenAt: iso(s.last_seen_at),
  createdAt: iso(s.created_at),
});

export const toPlan = (s: Pick<ServerRow, 'rate_plan' | 'hourly_krw' | 'household_kwh'>) => ({
  ratePlan: s.rate_plan,
  hourlyKrw: s.hourly_krw,
  householdKwh: s.household_kwh,
});

type SummaryRow = ServerRow & {
  latest_watts: number | null;
  latest_estimated: number | null;
  sample_watts: number;
  hourly_kwh: number;
  recent_watts: number | null;
};

/** One statement, so the month-to-date sum cannot straddle a rollup commit. */
export async function serverSummaries(userId: number, isOnline: (id: number) => boolean, serverId?: number) {
  const now = new Date();
  const month = kstMonth(now);
  const recentSince = new Date(now.getTime() - RECENT_WATTS_HOURS * 3_600_000);
  const found = await rows<SummaryRow>(
    `SELECT s.*,
       (SELECT m.watts FROM metrics m WHERE m.server_id = s.id ORDER BY m.ts DESC LIMIT 1) AS latest_watts,
       (SELECT m.is_estimated FROM metrics m WHERE m.server_id = s.id ORDER BY m.ts DESC LIMIT 1) AS latest_estimated,
       (SELECT COALESCE(SUM(m.watts), 0) FROM metrics m WHERE m.server_id = s.id AND m.ts >= ?) AS sample_watts,
       (SELECT COALESCE(SUM(h.kwh), 0) FROM metrics_hourly h WHERE h.server_id = s.id AND h.hour >= ?) AS hourly_kwh,
       (SELECT AVG(m.watts) FROM metrics m WHERE m.server_id = s.id AND m.ts >= ?) AS recent_watts
     FROM servers s WHERE s.user_id = ? AND (? IS NULL OR s.id = ?) ORDER BY s.id`,
    [month.start, month.start, recentSince, userId, serverId ?? null, serverId ?? null],
  );
  return found.map((s) => {
    const monthToDate = s.hourly_kwh + (s.sample_watts * METRIC_INTERVAL_SEC) / 3_600_000;
    const monthlyKwh = projectKwh(monthToDate, s.recent_watts ?? 0, month.remainingHours);
    return {
      ...toServer(s),
      online: isOnline(s.id),
      latestWatts: s.latest_watts,
      isEstimated: s.latest_estimated === null ? null : Boolean(s.latest_estimated),
      monthlyKwh: Math.round(monthlyKwh * 100) / 100,
      monthlyKrw: Math.round(monthlyCostKrw(toPlan(s), monthlyKwh, month)),
    };
  });
}

export type RecommendationRow = {
  id: number;
  server_id: number;
  consultation_id: number | null;
  source: 'rule' | 'ai';
  type: string;
  detail: string;
  est_saving_krw: number;
  status: 'open' | 'applied' | 'dismissed';
  created_at: Date;
  applied_at: Date | null;
};

export const toRecommendation = (r: RecommendationRow) => ({
  id: r.id,
  serverId: r.server_id,
  consultationId: r.consultation_id,
  source: r.source,
  type: r.type,
  detail: r.detail,
  estSavingKrw: r.est_saving_krw,
  status: r.status,
  createdAt: iso(r.created_at),
  appliedAt: iso(r.applied_at),
});

export type ConsultationRow = {
  id: number;
  server_id: number;
  requested_at: Date;
  auth_mode: 'subscription' | 'api_key';
  status: 'requested' | 'running' | 'done' | 'failed';
  summary: string | null;
};

export const toConsultation = (c: ConsultationRow) => ({
  id: c.id,
  serverId: c.server_id,
  requestedAt: iso(c.requested_at),
  authMode: c.auth_mode,
  status: c.status,
  summary: c.summary,
});

export const getConsultation = async (id: number) =>
  toConsultation((await one<ConsultationRow>('SELECT * FROM consultations WHERE id = ?', [id]))!);

export type ToolCallRow = {
  id: number;
  consultation_id: number;
  recommendation_id: number | null;
  command: string;
  tier: 'auto' | 'approve' | 'deny';
  decision: 'auto' | 'pending' | 'approved' | 'denied' | 'blocked';
  approved_at: Date | null;
  exit_code: number | null;
  undo_command: string | null;
  undo_of: number | null;
};

export const toToolCall = (t: ToolCallRow) => ({
  id: t.id,
  consultationId: t.consultation_id,
  recommendationId: t.recommendation_id,
  command: t.command,
  tier: t.tier,
  decision: t.decision,
  approvedAt: iso(t.approved_at),
  exitCode: t.exit_code,
  undoCommand: t.undo_command,
  undoOf: t.undo_of,
});

export const getToolCall = async (id: number) =>
  toToolCall((await one<ToolCallRow>('SELECT * FROM tool_calls WHERE id = ?', [id]))!);
