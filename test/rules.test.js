import assert from 'node:assert/strict';
import { test } from 'node:test';
import { evaluateRules } from '../src/rules.js';

const now = new Date('2026-11-06T03:00:00Z');
const HOUR = 3_600_000;

/** Hourly stats going back from now. */
function hours(count, stat) {
  return Array.from({ length: count }, (_, i) => {
    const hour = new Date(now.getTime() - (i + 1) * HOUR);
    const overrides = typeof stat === 'function' ? stat(hour) : stat;
    return { hour, cpuAvg: 20, cpuMax: 60, memMax: 70, watts: 100, ...overrides };
  });
}

function run(input) {
  return evaluateRules({ now, hours: [], processes: [], saving: (w) => w * 10, ...input });
}
const types = (input) => run(input).map((f) => f.type);

test('no data, no findings', () => {
  assert.deepEqual(run({}), []);
});

test('idle fires on a quiet day and reports the saving', () => {
  const findings = run({ hours: hours(24, { cpuAvg: 2, watts: 50 }) });
  const idle = findings.find((f) => f.type === 'idle');
  assert.equal(idle?.estSavingKrw, 500);
  assert.match(idle.detail, /50\.0W/);
});

test('idle needs enough hours and stays quiet on any busy hour', () => {
  assert.ok(!types({ hours: hours(10, { cpuAvg: 2 }) }).includes('idle'));
  assert.ok(!types({ hours: hours(24, (h) => ({ cpuAvg: h.getTime() === now.getTime() - HOUR ? 40 : 2 })) }).includes('idle'));
});

test('oversized needs three days of low peaks', () => {
  const low = { cpuMax: 20, memMax: 30, cpuAvg: 10 };
  assert.ok(types({ hours: hours(80, low) }).includes('oversized'));
  assert.ok(!types({ hours: hours(40, low) }).includes('oversized'));
  assert.ok(!types({ hours: hours(80, { ...low, cpuMax: 50 }) }).includes('oversized'));
  assert.ok(!types({ hours: hours(80, { ...low, memMax: 90 }) }).includes('oversized'));
  assert.equal(run({ hours: hours(80, { ...low, watts: 100 }) }).find((f) => f.type === 'oversized')?.estSavingKrw, 300);
});

test('night_stop wants quiet KST nights and busy days', () => {
  const pattern = (night, day) => (hour) => {
    const kst = (hour.getUTCHours() + 9) % 24;
    return { cpuAvg: kst >= 1 && kst < 7 ? night : day, watts: 80 };
  };
  const findings = run({ hours: hours(96, pattern(1, 30)) });
  assert.equal(findings.find((f) => f.type === 'night_stop')?.estSavingKrw, 200); // 80 W * 6/24 * 10
  assert.ok(!types({ hours: hours(96, pattern(30, 30)) }).includes('night_stop'));
  assert.ok(!types({ hours: hours(96, pattern(1, 1)) }).includes('night_stop'));
  assert.ok(!types({ hours: hours(6, pattern(1, 30)) }).includes('night_stop'));
});

function samples(minutes, pid, cpuPct) {
  return Array.from({ length: minutes }, (_, i) => ({
    ts: new Date(now.getTime() - i * 60_000),
    pid,
    name: `proc${pid}`,
    cpuPct: cpuPct(i),
    watts: 40,
  }));
}

test('runaway_process needs a sustained hog', () => {
  const findings = run({ processes: [...samples(30, 7, () => 95), ...samples(30, 8, () => 3)] });
  const runaway = findings.find((f) => f.type === 'runaway_process');
  assert.match(runaway.detail, /proc7/);
  assert.equal(runaway?.estSavingKrw, 400);
  assert.ok(!types({ processes: samples(10, 7, () => 95) }).includes('runaway_process'), 'too short');
  assert.ok(!types({ processes: samples(30, 7, (i) => (i % 2 ? 95 : 5)) }).includes('runaway_process'), 'intermittent');
});

test('runaway_process catches one pegged core on a four core server', () => {
  assert.ok(types({ processes: samples(30, 7, () => 25) }).includes('runaway_process'));
  assert.ok(!types({ processes: samples(30, 7, () => 12) }).includes('runaway_process'), 'a busy service is not a runaway');
});

test('runaway_process counts missed samples against the process', () => {
  const hog = samples(30, 7, () => 95).filter((_, i) => i % 2 === 0);
  assert.ok(!types({ processes: [...hog, ...samples(30, 8, () => 3)] }).includes('runaway_process'));
});

test('empty_game_server is never produced: no player data exists', () => {
  const quiet = hours(168, { cpuAvg: 1, cpuMax: 2, memMax: 3 });
  assert.ok(!types({ hours: quiet, processes: samples(30, 7, () => 95) }).includes('empty_game_server'));
});
