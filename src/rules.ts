// Pure recommendation rules over a metrics window. The job in jobs.ts supplies the data.
//
// empty_game_server is intentionally absent: api.md's agent messages carry no player count, so
// nothing supports it. Add it when `metrics` gains that field.

export type HourStat = { hour: Date; cpuAvg: number; cpuMax: number; memMax: number; watts: number };
export type ProcessPoint = { ts: Date; pid: number; name: string; cpuPct: number; watts: number };
export type RuleInput = {
  now: Date;
  /** Hourly buckets, up to the last WINDOW_DAYS days. */
  hours: HourStat[];
  /** Raw samples, up to the last RUNAWAY_WINDOW_MIN minutes. */
  processes: ProcessPoint[];
  /** Monthly KRW saved by cutting this many watts. */
  saving: (watts: number) => number;
};
export type Finding = { type: string; detail: string; estSavingKrw: number };

export const WINDOW_DAYS = 7;
export const RUNAWAY_WINDOW_MIN = 30;

const IDLE_CPU_PCT = 5;
const IDLE_MIN_HOURS = 20;

const OVERSIZED_CPU_PCT = 30;
const OVERSIZED_MEM_PCT = 40;
const OVERSIZED_MIN_HOURS = 72;
const OVERSIZED_SAVING_SHARE = 0.3; // ponytail: flat guess, a real figure needs instance size data

const NIGHT_START_KST = 1; // 01:00 to 07:00
const NIGHT_HOURS = 6;
const NIGHT_MIN_SAMPLES = 12; // roughly two full nights

const RUNAWAY_CPU_PCT = 80;
const RUNAWAY_MIN_SHARE = 0.9;
const RUNAWAY_MIN_SPAN_MIN = 25;

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
const won = (krw: number) => Math.max(0, Math.round(krw));
const fmt = (n: number) => n.toFixed(1);

function idle({ now, hours, saving }: RuleInput): Finding | null {
  const recent = hours.filter((h) => h.hour.getTime() >= now.getTime() - 24 * 3_600_000);
  if (recent.length < IDLE_MIN_HOURS || recent.some((h) => h.cpuAvg >= IDLE_CPU_PCT)) return null;
  const watts = mean(recent.map((h) => h.watts));
  return {
    type: 'idle',
    detail: `최근 24시간 CPU 사용률이 시간 평균 ${IDLE_CPU_PCT}% 미만입니다. 평균 ${fmt(watts)}W를 쓰고 있어 서버를 꺼두면 절약할 수 있습니다.`,
    estSavingKrw: won(saving(watts)),
  };
}

function oversized({ hours, saving }: RuleInput): Finding | null {
  if (hours.length < OVERSIZED_MIN_HOURS) return null;
  const cpuPeak = Math.max(...hours.map((h) => h.cpuMax));
  const memPeak = Math.max(...hours.map((h) => h.memMax));
  if (cpuPeak >= OVERSIZED_CPU_PCT || memPeak >= OVERSIZED_MEM_PCT) return null;
  const watts = mean(hours.map((h) => h.watts));
  return {
    type: 'oversized',
    detail: `최근 ${WINDOW_DAYS}일 최대 CPU ${fmt(cpuPeak)}%, 최대 메모리 ${fmt(memPeak)}%로 사양에 여유가 많습니다. 더 작은 사양으로 옮기는 것을 검토해 보세요.`,
    estSavingKrw: won(saving(watts * OVERSIZED_SAVING_SHARE)),
  };
}

function nightStop({ hours, saving }: RuleInput): Finding | null {
  const isNight = (h: HourStat) => {
    const kstHour = (h.hour.getUTCHours() + 9) % 24;
    return kstHour >= NIGHT_START_KST && kstHour < NIGHT_START_KST + NIGHT_HOURS;
  };
  const night = hours.filter(isNight);
  const day = hours.filter((h) => !isNight(h));
  if (night.length < NIGHT_MIN_SAMPLES || day.length === 0) return null;
  // Idle around the clock belongs to the idle rule; this one needs a daytime workload.
  if (mean(night.map((h) => h.cpuAvg)) >= IDLE_CPU_PCT || mean(day.map((h) => h.cpuAvg)) < IDLE_CPU_PCT) return null;
  const watts = mean(night.map((h) => h.watts));
  return {
    type: 'night_stop',
    detail: `새벽 시간대(${NIGHT_START_KST}시~${NIGHT_START_KST + NIGHT_HOURS}시) CPU 사용이 거의 없습니다. 이 시간에 평균 ${fmt(watts)}W를 쓰고 있어 야간 중지로 절약할 수 있습니다.`,
    estSavingKrw: won(saving((watts * NIGHT_HOURS) / 24)),
  };
}

function runawayProcess({ processes, saving }: RuleInput): Finding | null {
  const times = processes.map((p) => p.ts.getTime());
  if (times.length === 0) return null;
  if (Math.max(...times) - Math.min(...times) < RUNAWAY_MIN_SPAN_MIN * 60_000) return null;

  const hotByProcess = new Map<string, ProcessPoint[]>();
  for (const p of processes) {
    if (p.cpuPct < RUNAWAY_CPU_PCT) continue;
    const key = `${p.pid}:${p.name}`;
    hotByProcess.set(key, [...(hotByProcess.get(key) ?? []), p]);
  }
  const sampleCount = new Set(times).size;
  const runaway = [...hotByProcess.values()]
    .filter((hot) => hot.length >= sampleCount * RUNAWAY_MIN_SHARE)
    .map((hot) => ({ first: hot[0]!, watts: mean(hot.map((p) => p.watts)) }))
    .sort((a, b) => b.watts - a.watts)[0];
  if (!runaway) return null;
  return {
    type: 'runaway_process',
    detail: `프로세스 ${runaway.first.name}(PID ${runaway.first.pid})가 ${RUNAWAY_WINDOW_MIN}분 가까이 CPU ${RUNAWAY_CPU_PCT}% 이상을 쓰고 있습니다. 평균 ${fmt(runaway.watts)}W를 소비합니다.`,
    estSavingKrw: won(saving(runaway.watts)),
  };
}

export function evaluateRules(input: RuleInput): Finding[] {
  return [idle, oversized, nightStop, runawayProcess]
    .map((rule) => rule(input))
    .filter((f): f is Finding => f !== null);
}
