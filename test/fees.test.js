import assert from 'node:assert/strict';
import { test } from 'node:test';
import { homeBillKrw, kstMonth, marginalHomeCostKrw, monthlyCostKrw, projectKwh, savingKrw } from '../src/fees.js';

const near = (actual, expected) => assert.ok(Math.abs(actual - expected) < 1e-6, `${actual} != ${expected}`);

test('non-summer tiers: base follows the top tier, energy is progressive', () => {
  near(homeBillKrw(0, 3), 910);
  near(homeBillKrw(200, 3), 910 + 200 * 120);
  near(homeBillKrw(201, 3), 1600 + 200 * 120 + 214.6);
  near(homeBillKrw(400, 3), 1600 + 200 * 120 + 200 * 214.6);
  near(homeBillKrw(450, 3), 7300 + 200 * 120 + 200 * 214.6 + 50 * 307.3);
});

test('July and August use wider tiers at the same prices', () => {
  near(homeBillKrw(300, 7), 910 + 300 * 120);
  near(homeBillKrw(301, 8), 1600 + 300 * 120 + 214.6);
  near(homeBillKrw(460, 8), 7300 + 300 * 120 + 150 * 214.6 + 10 * 307.3);
  assert.notEqual(homeBillKrw(300, 6), homeBillKrw(300, 7));
  assert.notEqual(homeBillKrw(300, 9), homeBillKrw(300, 8));
});

test('server cost is marginal across a tier boundary', () => {
  near(marginalHomeCostKrw(350, 100, 3), 89585 - 57790);
  near(marginalHomeCostKrw(350, 0, 3), 0);
  // The same 100 kWh costs less on top of a small household.
  assert.ok(marginalHomeCostKrw(50, 100, 3) < marginalHomeCostKrw(350, 100, 3));
});

test('kstMonth uses the KST calendar', () => {
  // 2026-07-31 15:00 UTC is already August 1 in KST.
  const m = kstMonth(new Date('2026-07-31T15:00:00Z'));
  assert.equal(m.month, 8);
  assert.equal(m.start.toISOString(), '2026-07-31T15:00:00.000Z');
  assert.equal(m.hours, 31 * 24);
  assert.equal(m.remainingHours, 31 * 24);
  assert.equal(kstMonth(new Date('2026-02-10T00:00:00Z')).hours, 28 * 24);
});

test('cloud_hourly costs the hourly price for every hour of the month', () => {
  const m = kstMonth(new Date('2026-11-06T00:00:00Z'));
  assert.equal(monthlyCostKrw({ ratePlan: 'cloud_hourly', hourlyKrw: 42.5, householdKwh: 0 }, 999, m), 42.5 * 720);
});

test('home_tiered monthly cost ignores nothing but the household baseline', () => {
  const m = kstMonth(new Date('2026-11-06T00:00:00Z'));
  near(monthlyCostKrw({ ratePlan: 'home_tiered', hourlyKrw: null, householdKwh: 350 }, 100, m), 89585 - 57790);
});

test('projection adds remaining hours at the recent draw', () => {
  near(projectKwh(10, 100, 200), 30);
  near(projectKwh(10, 0, 200), 10);
});

test('saving is the cost difference, and zero without a baseline', () => {
  const m = kstMonth(new Date('2026-11-06T00:00:00Z'));
  const home = { ratePlan: 'home_tiered', hourlyKrw: null, householdKwh: 150 };
  near(savingKrw(home, 100, 100, m), marginalHomeCostKrw(150, 72, m.month));
  near(savingKrw({ ratePlan: 'cloud_hourly', hourlyKrw: 100, householdKwh: 0 }, 100, 25, m), 100 * 720 * 0.25);
  assert.equal(savingKrw(home, 0, 0, m), 0);
});
