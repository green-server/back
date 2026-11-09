import { rows } from './db.js';
import { co2Kg, kstMonth, monthlyCostKrw, savingKrw, type KstMonth, type RatePlan } from './fees.js';
import { iso, toPlan, type ServerRow } from './models.js';

type ItemRow = Pick<ServerRow, 'rate_plan' | 'hourly_krw' | 'household_kwh'> & {
  recommendation_id: number;
  server_name: string;
  source: 'rule' | 'ai';
  type: string;
  applied_at: Date;
  before_watts: number;
  after_watts: number;
  stopped_share: number;
};

const round2 = (n: number) => Math.round(n * 100) / 100;

/** A stopped cloud instance saves its hourly fee; a lower draw on a running one saves nothing. */
export function savedKrwMonth(
  plan: RatePlan,
  beforeWatts: number,
  afterWatts: number,
  stoppedShare: number,
  month: KstMonth,
): number {
  return plan.ratePlan === 'cloud_hourly'
    ? monthlyCostKrw(plan, 0, month) * stoppedShare
    : savingKrw(plan, beforeWatts, beforeWatts - afterWatts, month);
}

export async function savingsReport(userId: number, serverId: number | null, now = new Date()) {
  const month = kstMonth(now);
  const owned = 'SELECT id FROM servers WHERE user_id = ? AND (? IS NULL OR id = ?)';
  const scope = [userId, serverId, serverId];

  // metrics_hourly only gains rows after 7 days, so `hourly` adds the raw data not yet rolled up;
  // otherwise a fresh action has nothing to measure for a week. Each hour before the action pairs
  // with the same clock hour a day later, which keeps the day/night mix equal on both sides. The
  // hour holding applied_at is on neither side, and only finished hours count. LEFT JOIN: a stopped
  // server reports nothing, so a missing hour is 0 W. The agent holds samples through a link outage
  // and sends them on reconnect, so a gap means the agent was not running.
  // A pair that spans another applied change on the same server belongs to neither: the drop
  // could be either one's, and crediting both would count it twice.
  const items = await rows<ItemRow>(
    `WITH hourly AS (
       SELECT server_id, hour, avg_watts FROM metrics_hourly WHERE server_id IN (${owned})
       UNION ALL
       SELECT server_id, CAST(DATE_FORMAT(ts, '%Y-%m-%d %H:00:00') AS DATETIME) AS hour, AVG(watts)
       FROM metrics WHERE server_id IN (${owned}) GROUP BY server_id, hour
     ), applied AS (
       SELECT r.*, CAST(DATE_FORMAT(r.applied_at, '%Y-%m-%d %H:00:00') AS DATETIME) AS applied_hour
       FROM recommendations r WHERE r.status = 'applied' AND r.server_id IN (${owned})
     )
     SELECT r.id AS recommendation_id, s.name AS server_name, s.rate_plan, s.hourly_krw, s.household_kwh,
            r.source, r.type, r.applied_at,
            AVG(b.avg_watts) AS before_watts,
            AVG(COALESCE(a.avg_watts, 0)) AS after_watts,
            AVG(a.hour IS NULL) AS stopped_share
     FROM applied r
     JOIN servers s ON s.id = r.server_id
     JOIN hourly b ON b.server_id = r.server_id
       AND b.hour >= r.applied_hour - INTERVAL 23 HOUR AND b.hour < r.applied_hour
       AND b.hour + INTERVAL 25 HOUR <= ?
     LEFT JOIN hourly a ON a.server_id = b.server_id AND a.hour = b.hour + INTERVAL 24 HOUR
     WHERE NOT EXISTS (
       SELECT 1 FROM applied o
       WHERE o.server_id = r.server_id AND o.id <> r.id
         AND o.applied_hour >= b.hour AND o.applied_hour <= b.hour + INTERVAL 24 HOUR
     )
     GROUP BY r.id, r.source, r.type, r.applied_at, s.id
     ORDER BY r.applied_at DESC`,
    [...scope, ...scope, ...scope, now],
  );

  const reported = items.map((i) => {
    const savedWatts = i.before_watts - i.after_watts;
    return {
      recommendationId: i.recommendation_id,
      serverName: i.server_name,
      source: i.source,
      type: i.type,
      appliedAt: iso(i.applied_at)!,
      beforeWatts: round2(i.before_watts),
      afterWatts: round2(i.after_watts),
      savedKwhMonth: round2((savedWatts * month.hours) / 1000),
      savedCo2KgMonth: co2Kg((savedWatts * month.hours) / 1000),
      savedKrwMonth: Math.round(savedKrwMonth(toPlan(i), i.before_watts, i.after_watts, i.stopped_share, month)),
    };
  });

  const sources = await rows<{ source: 'rule' | 'ai'; total: number; applied: number }>(
    `SELECT src.source, COUNT(r.id) AS total, COALESCE(SUM(r.status = 'applied'), 0) AS applied
     FROM (SELECT 'rule' AS source UNION ALL SELECT 'ai') AS src
     LEFT JOIN recommendations r ON r.source = src.source COLLATE utf8mb4_0900_ai_ci
       AND r.server_id IN (${owned})
     GROUP BY src.source`,
    scope,
  );

  return {
    items: reported,
    bySource: sources.map((s) => ({
      source: s.source,
      total: s.total,
      applied: Number(s.applied),
      savedKrwMonth: reported.filter((i) => i.source === s.source).reduce((sum, i) => sum + i.savedKrwMonth, 0),
      savedCo2KgMonth: round2(reported.filter((i) => i.source === s.source).reduce((sum, i) => sum + i.savedCo2KgMonth, 0)),
    })),
    total: {
      savedKrwMonth: reported.reduce((sum, i) => sum + i.savedKrwMonth, 0),
      savedCo2KgMonth: round2(reported.reduce((sum, i) => sum + i.savedCo2KgMonth, 0)),
    },
  };
}
