// Row shapes and their api.md JSON form.
import { one, rows } from './db.js';
import { co2Kg, kstMonth, monthlyCostKrw, projectKwh } from './fees.js';

/** The agent reports every 10 seconds, so each sample stands for 10 seconds of energy. */
export const METRIC_INTERVAL_SEC = 10;
const RECENT_WATTS_HOURS = 24;

export const iso = (d) => (d ? d.toISOString() : null);

export const toUser = (u) => ({ id: u.id, email: u.email, name: u.name, createdAt: iso(u.created_at) });

export const toServer = (s) => ({
  id: s.id,
  name: s.name,
  kind: s.kind,
  ratePlan: s.rate_plan,
  hourlyKrw: s.hourly_krw,
  householdKwh: s.household_kwh,
  powerSource: s.power_source,
  lastSeenAt: iso(s.last_seen_at),
  location:
    s.latitude === null || s.longitude === null ? null : { lat: s.latitude, lon: s.longitude, label: s.location ?? '' },
  createdAt: iso(s.created_at),
});

export const toPlan = (s) => ({
  ratePlan: s.rate_plan,
  hourlyKrw: s.hourly_krw,
  householdKwh: s.household_kwh,
});

/**
 * One statement, so the month-to-date sum cannot straddle a rollup commit.
 * A cloud instance is billed for the hours it reported this month plus the rest of the month,
 * so one created mid-month or stopped for a week is not charged for those hours.
 */
export async function serverSummaries(userId, isOnline, serverId) {
  const now = new Date();
  const month = kstMonth(now);
  const recentSince = new Date(now.getTime() - RECENT_WATTS_HOURS * 3_600_000);
  // Raw metrics are kept for 7 days, so this is the whole raw table for the server.
  const weekSince = new Date(now.getTime() - 7 * 24 * 3_600_000);
  const found = await rows(
    `SELECT s.*, l.watts AS latest_watts, l.is_estimated AS latest_estimated,
       mt.sample_watts, mt.sample_hours, hr.hourly_kwh, hr.hourly_hours, rc.recent_watts, wk.week_watts
     FROM servers s
     LEFT JOIN LATERAL (
       SELECT m.watts, m.is_estimated FROM metrics m WHERE m.server_id = s.id ORDER BY m.ts DESC LIMIT 1
     ) l ON TRUE
     JOIN LATERAL (
       SELECT COALESCE(SUM(m.watts), 0) AS sample_watts, COUNT(DISTINCT DATE_FORMAT(m.ts, '%Y-%m-%d %H')) AS sample_hours
       FROM metrics m WHERE m.server_id = s.id AND m.ts >= ?
     ) mt ON TRUE
     JOIN LATERAL (
       SELECT COALESCE(SUM(h.kwh), 0) AS hourly_kwh, COUNT(*) AS hourly_hours
       FROM metrics_hourly h WHERE h.server_id = s.id AND h.hour >= ?
     ) hr ON TRUE
     JOIN LATERAL (SELECT AVG(m.watts) AS recent_watts FROM metrics m WHERE m.server_id = s.id AND m.ts >= ?) rc ON TRUE
     JOIN LATERAL (SELECT AVG(m.watts) AS week_watts FROM metrics m WHERE m.server_id = s.id AND m.ts >= ?) wk ON TRUE
     WHERE s.user_id = ? AND (? IS NULL OR s.id = ?) ORDER BY s.id`,
    [month.start, month.start, recentSince, weekSince, userId, serverId ?? null, serverId ?? null],
  );
  return found.map((s) => {
    const monthToDate = s.hourly_kwh + (s.sample_watts * METRIC_INTERVAL_SEC) / 3_600_000;
    const monthlyKwh = projectKwh(monthToDate, s.recent_watts ?? 0, month.remainingHours);
    return {
      ...toServer(s),
      online: isOnline(s.id),
      latestWatts: s.latest_watts,
      weekWatts: s.week_watts === null ? null : Math.round(s.week_watts * 100) / 100,
      isEstimated: s.latest_estimated === null ? null : Boolean(s.latest_estimated),
      monthlyKwh: Math.round(monthlyKwh * 100) / 100,
      monthlyCo2Kg: co2Kg(monthlyKwh),
      monthlyKrw: Math.round(
        monthlyCostKrw(toPlan(s), monthlyKwh, month, Number(s.sample_hours) + Number(s.hourly_hours) + month.remainingHours),
      ),
    };
  });
}

export const toRecommendation = (r) => ({
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

export const toConsultation = (c) => ({
  id: c.id,
  serverId: c.server_id,
  requestedAt: iso(c.requested_at),
  authMode: c.auth_mode,
  model: c.model,
  status: c.status,
  summary: c.summary,
  level: c.server_level,
  feedback: c.feedback ?? [],
  fixes: c.fixes ?? [],
});

export const getConsultation = async (id) =>
  toConsultation(await one('SELECT * FROM consultations WHERE id = ?', [id]));

export const toToolCall = (t) => ({
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

export const getToolCall = async (id) =>
  toToolCall(await one('SELECT * FROM tool_calls WHERE id = ?', [id]));
