// Pure fee calculation. Nothing here touches the database or the clock.

// Source: KEPCO tariff table, residential low-voltage (주택용전력 저압), https://online.kepco.co.kr
// Excludes VAT and the electricity fund, which the plan does not model.
const TIER_PRICES_KRW = [120.0, 214.6, 307.3] as const;
const TIER_BASE_KRW = [910, 1600, 7300] as const;
const TIER_LIMITS_KWH = [200, 400] as const;
const SUMMER_TIER_LIMITS_KWH = [300, 450] as const;
const SUMMER_MONTHS = [7, 8];

const KST_OFFSET_MS = 9 * 3_600_000;
const HOUR_MS = 3_600_000;

export type RatePlan = {
  ratePlan: 'home_tiered' | 'cloud_hourly';
  hourlyKrw: number | null;
  householdKwh: number;
};

/** Monthly household bill for total kWh. month is 1-12. */
export function homeBillKrw(kwh: number, month: number): number {
  const [limit1, limit2] = SUMMER_MONTHS.includes(month) ? SUMMER_TIER_LIMITS_KWH : TIER_LIMITS_KWH;
  const [price1, price2, price3] = TIER_PRICES_KRW;
  const [base1, base2, base3] = TIER_BASE_KRW;
  if (kwh <= limit1) return base1 + kwh * price1;
  if (kwh <= limit2) return base2 + limit1 * price1 + (kwh - limit1) * price2;
  return base3 + limit1 * price1 + (limit2 - limit1) * price2 + (kwh - limit2) * price3;
}

/** What the server adds to the household bill, not an average share of it. */
export function marginalHomeCostKrw(householdKwh: number, serverKwh: number, month: number): number {
  return homeBillKrw(householdKwh + serverKwh, month) - homeBillKrw(householdKwh, month);
}

/** Billing calendar month in KST, whatever the UTC date is. */
export function kstMonth(now: Date) {
  const kst = new Date(now.getTime() + KST_OFFSET_MS);
  const year = kst.getUTCFullYear();
  const index = kst.getUTCMonth();
  const start = new Date(Date.UTC(year, index, 1) - KST_OFFSET_MS);
  const end = new Date(Date.UTC(year, index + 1, 1) - KST_OFFSET_MS);
  return {
    month: index + 1,
    start,
    hours: (end.getTime() - start.getTime()) / HOUR_MS,
    remainingHours: (end.getTime() - now.getTime()) / HOUR_MS,
  };
}

export type KstMonth = ReturnType<typeof kstMonth>;

export function monthlyCostKrw(plan: RatePlan, serverKwh: number, m: KstMonth): number {
  return plan.ratePlan === 'cloud_hourly'
    ? (plan.hourlyKrw ?? 0) * m.hours
    : marginalHomeCostKrw(plan.householdKwh, serverKwh, m.month);
}

/** Month-to-date kWh plus the remaining hours at the recent average draw. */
export function projectKwh(monthToDateKwh: number, recentWatts: number, remainingHours: number): number {
  return monthToDateKwh + (remainingHours * recentWatts) / 1000;
}

/**
 * Monthly KRW saved by cutting savedWatts from a server averaging avgWatts.
 * ponytail: on cloud_hourly this treats the saved power share as the saved billed share, which
 * only holds when the saving comes from stopping or downsizing the instance.
 */
export function savingKrw(plan: RatePlan, avgWatts: number, savedWatts: number, m: KstMonth): number {
  if (avgWatts <= 0) return 0;
  if (plan.ratePlan === 'cloud_hourly') return monthlyCostKrw(plan, 0, m) * (savedWatts / avgWatts);
  const kwh = (w: number) => (w * m.hours) / 1000;
  return monthlyCostKrw(plan, kwh(avgWatts), m) - monthlyCostKrw(plan, kwh(avgWatts - savedWatts), m);
}
