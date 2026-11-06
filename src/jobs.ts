import { RAW_RETENTION_MS } from './agent.js';
import { rows, run, tx } from './db.js';
import { kstMonth, savingKrw } from './fees.js';
import { METRIC_INTERVAL_SEC, toPlan, type ServerRow } from './models.js';
import { evaluateRules, RUNAWAY_WINDOW_MIN, WINDOW_DAYS, type Finding, type HourStat, type ProcessPoint } from './rules.js';
import { denyStalePending } from './toolCalls.js';

const ROLLUP_INTERVAL_MS = 3_600_000;
const RULES_INTERVAL_MS = 10 * 60_000;
const HOUR_MS = 3_600_000;
/** A rule that was dismissed or acted on stays quiet this long instead of firing on the next tick. */
const RENOTIFY_DAYS = 7;

const hourBucket = "CAST(DATE_FORMAT(ts, '%Y-%m-%d %H:00:00') AS DATETIME)";

/**
 * Moves metrics older than 7 days into metrics_hourly. The cutoff is floored to the hour so a bucket
 * is only ever written once; ingest refuses samples past retention, so none can land behind it.
 */
export async function rollup(now = new Date()): Promise<void> {
  const cutoff = new Date(Math.floor((now.getTime() - RAW_RETENTION_MS) / HOUR_MS) * HOUR_MS);
  await tx(async (c) => {
    await run(
      `INSERT INTO metrics_hourly (server_id, hour, avg_watts, kwh)
       SELECT * FROM (
         SELECT server_id, ${hourBucket} AS h, AVG(watts) AS w, SUM(watts) * ? / 3600000 AS k
         FROM metrics WHERE ts < ? GROUP BY server_id, h
       ) AS n
       ON DUPLICATE KEY UPDATE kwh = metrics_hourly.kwh + n.k, avg_watts = (metrics_hourly.avg_watts + n.w) / 2`,
      [METRIC_INTERVAL_SEC, cutoff],
      c,
    );
    await run('DELETE FROM metrics WHERE ts < ?', [cutoff], c);
    await run('DELETE FROM process_samples WHERE ts < ?', [cutoff], c);
  });
}

async function findingsFor(server: ServerRow, now: Date): Promise<Finding[]> {
  const hours = await rows<{ hour: Date; cpu_avg: number; cpu_max: number; mem_max: number; watts: number }>(
    `SELECT ${hourBucket} AS hour, AVG(cpu_pct) AS cpu_avg, MAX(cpu_pct) AS cpu_max, MAX(mem_pct) AS mem_max, AVG(watts) AS watts
     FROM metrics WHERE server_id = ? AND ts >= ? GROUP BY hour ORDER BY hour`,
    [server.id, new Date(now.getTime() - WINDOW_DAYS * 24 * HOUR_MS)],
  );
  const processes = await rows<{ ts: Date; pid: number; name: string; cpu_pct: number; watts: number }>(
    'SELECT ts, pid, name, cpu_pct, watts FROM process_samples WHERE server_id = ? AND ts >= ?',
    [server.id, new Date(now.getTime() - RUNAWAY_WINDOW_MIN * 60_000)],
  );
  const stats: HourStat[] = hours.map((h) => ({ hour: h.hour, cpuAvg: h.cpu_avg, cpuMax: h.cpu_max, memMax: h.mem_max, watts: h.watts }));
  const points: ProcessPoint[] = processes.map((p) => ({ ts: p.ts, pid: p.pid, name: p.name, cpuPct: p.cpu_pct, watts: p.watts }));
  const avgWatts = stats.reduce((sum, h) => sum + h.watts, 0) / (stats.length || 1);
  const month = kstMonth(now);
  return evaluateRules({
    now,
    hours: stats,
    processes: points,
    saving: (watts) => savingKrw(toPlan(server), avgWatts, watts, month),
  });
}

export async function runRules(now = new Date()): Promise<void> {
  for (const server of await rows<ServerRow>('SELECT * FROM servers')) {
    for (const f of await findingsFor(server, now)) {
      await run(
        `INSERT INTO recommendations (server_id, source, type, detail, est_saving_krw)
         SELECT ?, 'rule', ?, ?, ? FROM DUAL
         WHERE NOT EXISTS (
           SELECT 1 FROM recommendations
           WHERE server_id = ? AND type = ? AND (status = 'open' OR created_at > ? - INTERVAL ? DAY)
         )`,
        [server.id, f.type, f.detail, f.estSavingKrw, server.id, f.type, now, RENOTIFY_DAYS],
      );
    }
  }
}

export function startJobs(): void {
  const every = (ms: number, job: () => Promise<unknown>) => {
    const tick = () => job().catch(console.error);
    void tick();
    setInterval(tick, ms);
  };
  void denyStalePending().catch(console.error);
  every(ROLLUP_INTERVAL_MS, rollup);
  every(RULES_INTERVAL_MS, runRules);
}
