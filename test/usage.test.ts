import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { centsPerKwh, cost, isHighTariff } from "../src/core/tariff";
import type { AcState, Electricity } from "../src/core/types";
import { estimateLoad, UsageLog } from "../src/core/usage";

const state = (over: Partial<AcState> = {}): AcState => ({
  power: true, mode: "cool", target: 24, indoor: 27, outdoor: 31, fan: "auto", swing: "off",
  eco: false, turbo: false, sleep: false, display: true, selfClean: false, filter: false, humidity: null, watts: null, kwh: null, errorCode: 0,
  ...over,
});
const single: Electricity = { meter: "single", block: 2, vat: false, ratedWatts: 1000 };
const fresh = () => new UsageLog(join(mkdtempSync(join(tmpdir(), "mideabar-")), "usage.json"));
const at = (y: number, mo: number, d: number, h: number, mi = 0) => new Date(y, mo - 1, d, h, mi).getTime();
const near = (a: number, b: number, eps = 1e-6) => assert.ok(Math.abs(a - b) < eps, `${a} is not ${b}`);

test("KESCO prices: single and two-tariff, both blocks, with and without VAT", () => {
  assert.deepEqual(centsPerKwh({ ...single, block: 1 }), { high: 7.12, low: 7.12 });
  assert.deepEqual(centsPerKwh(single), { high: 12.39, low: 12.39 });
  assert.deepEqual(centsPerKwh({ ...single, meter: "dual", block: 1 }), { high: 9.05, low: 3.88 });
  assert.deepEqual(centsPerKwh({ ...single, meter: "dual" }), { high: 15.43, low: 7.28 });
  near(centsPerKwh({ ...single, vat: true }).high, 12.39 * 1.08);
  near(cost(10, 5, { ...single, meter: "dual", block: 1 }), (10 * 9.05 + 5 * 3.88) / 100);
});

test("high tariff hours follow the season", () => {
  // Winter, 1 October to 31 March: 07:00 to 22:00.
  assert.equal(isHighTariff(new Date(2026, 9, 11, 6, 59)), false);
  assert.equal(isHighTariff(new Date(2026, 9, 11, 7, 0)), true);
  assert.equal(isHighTariff(new Date(2026, 9, 11, 21, 59)), true);
  assert.equal(isHighTariff(new Date(2026, 9, 11, 22, 0)), false);
  assert.equal(isHighTariff(new Date(2027, 2, 31, 7, 30)), true);
  // Summer, 1 April to 30 September: 08:00 to 23:00.
  assert.equal(isHighTariff(new Date(2026, 6, 15, 7, 30)), false);
  assert.equal(isHighTariff(new Date(2026, 6, 15, 8, 0)), true);
  assert.equal(isHighTariff(new Date(2026, 6, 15, 22, 30)), true);
  assert.equal(isHighTariff(new Date(2026, 6, 15, 23, 0)), false);
});

test("load estimate tracks how far the room is from the target", () => {
  assert.equal(estimateLoad(state({ power: false })), 0);
  assert.equal(estimateLoad(state({ indoor: 27, target: 24 })), 1);
  assert.equal(estimateLoad(state({ indoor: 24, target: 24 })), 0.25);
  near(estimateLoad(state({ indoor: 25.5, target: 24 })), 0.625);
  assert.equal(estimateLoad(state({ mode: "heat", indoor: 18, target: 22 })), 1);
  assert.equal(estimateLoad(state({ mode: "heat", indoor: 23, target: 22 })), 0.25);
  assert.equal(estimateLoad(state({ mode: "fan" })), 0.05);
  assert.equal(estimateLoad(state({ indoor: 24, target: 24, turbo: true })), 1);
  near(estimateLoad(state({ indoor: 24, target: 24, eco: true })), 0.2125);
});

test("estimates an unmetered unit from running time, minute by minute", () => {
  const log = fresh();
  const t0 = at(2026, 10, 11, 14, 0);
  // Flat out for an hour, sampled every minute.
  for (let m = 0; m <= 60; m++) log.record(state(), t0 + m * 60_000);
  const sum = log.summary(single, new Date(t0 + 61 * 60_000));
  assert.equal(sum.metered, false);
  assert.equal(sum.needsRating, false);
  near(sum.today.kwh, 1.0);
  near(sum.today.minutes, 60);
  near(sum.today.cost, 0.1239);
  near(sum.month.cost, 0.1239);
  assert.equal(sum.days.length, 14);
  assert.equal(sum.days.at(-1)!.date, "2026-10-11");
  near(sum.days.at(-1)!.cost, 0.1239);
});

test("changing the rated power or the tariff re-prices the history", () => {
  const log = fresh();
  const t0 = at(2026, 10, 11, 14, 0);
  for (let m = 0; m <= 60; m++) log.record(state(), t0 + m * 60_000);
  const now = new Date(t0 + 61 * 60_000);
  near(log.summary({ ...single, ratedWatts: 2000 }, now).today.kwh, 2.0);
  near(log.summary({ ...single, block: 1 }, now).today.cost, 0.0712);
  near(log.summary({ ...single, vat: true }, now).today.cost, 0.1239 * 1.08);
  const none = log.summary({ ...single, ratedWatts: null }, now);
  assert.equal(none.needsRating, true);
  assert.equal(none.today.kwh, 0);
});

test("splits use across the night tariff boundary and across midnight", () => {
  const log = fresh();
  const dual: Electricity = { meter: "dual", block: 1, vat: false, ratedWatts: 1000 };
  // 21:00 to 01:00 in October, flat out: one hour at the day price, three at night, the last on the next day.
  const t0 = at(2026, 10, 11, 21, 0);
  for (let m = 0; m <= 240; m++) log.record(state(), t0 + m * 60_000);
  const day1 = log.summary(dual, new Date(at(2026, 10, 11, 23, 59)));
  near(day1.today.kwh, 3.0);
  near(day1.today.cost, (1 * 9.05 + 2 * 3.88) / 100);
  const day2 = log.summary(dual, new Date(at(2026, 10, 12, 1, 30)));
  near(day2.today.kwh, 1.0);
  near(day2.today.cost, 3.88 / 100);
  near(day2.month.kwh, 4.0);
});

test("uses the unit's own meter when it has one, however long the app looked away", () => {
  const log = fresh();
  const t0 = at(2026, 10, 11, 9, 0);
  log.record(state({ kwh: 500.0 }), t0);
  log.record(state({ kwh: 503.0 }), t0 + 3 * 3_600_000); // the Mac slept for three hours
  const sum = log.summary({ ...single, ratedWatts: null }, new Date(t0 + 4 * 3_600_000));
  assert.equal(sum.metered, true);
  assert.equal(sum.needsRating, false);
  near(sum.today.kwh, 3.0);
  near(sum.today.cost, 3 * 0.1239);
  // A meter that goes backwards (reset) or jumps absurdly is ignored.
  log.record(state({ kwh: 2.0 }), t0 + 4 * 3_600_000);
  log.record(state({ kwh: 99999 }), t0 + 5 * 3_600_000);
  near(log.summary(single, new Date(t0 + 6 * 3_600_000)).today.kwh, 3.0);
});

test("while nobody was watching, assumes it kept running, or stopped halfway", () => {
  const log = fresh();
  const t0 = at(2026, 10, 11, 9, 0);
  const maintain = state({ indoor: 24, target: 24 }); // 25% of rated power
  log.record(maintain, t0);
  log.record(maintain, t0 + 4 * 3_600_000); // still on four hours later
  let sum = log.summary(single, new Date(t0 + 5 * 3_600_000));
  near(sum.today.kwh, 1.0);
  near(sum.assumedMinutes, 240);

  log.record(state({ power: false }), t0 + 6 * 3_600_000); // found off two hours after that
  sum = log.summary(single, new Date(t0 + 7 * 3_600_000));
  near(sum.today.kwh, 1.25);
  near(sum.assumedMinutes, 300);

  log.record(state(), t0 + 10 * 3_600_000); // off before, on now: nothing is assumed
  near(log.summary(single, new Date(t0 + 11 * 3_600_000)).today.kwh, 1.25);
});

test("the log survives a restart", () => {
  const log = fresh();
  const t0 = at(2026, 10, 11, 14, 0);
  for (let m = 0; m <= 30; m++) log.record(state(), t0 + m * 60_000);
  log.save(true);
  near(new UsageLog(log.path).summary(single, new Date(t0 + 3_600_000)).today.kwh, 0.5);
});
