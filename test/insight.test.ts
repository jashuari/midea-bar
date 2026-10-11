import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { checkAlerts } from "../src/core/alerts";
import { HistoryLog } from "../src/core/history";
import type { AcState } from "../src/core/types";

const MIN = 60_000;
const HOUR = 60 * MIN;
const state = (over: Partial<AcState> = {}): AcState => ({
  power: true, mode: "heat", target: 22, indoor: 18, outdoor: 5, fan: "auto", swing: "off",
  eco: false, turbo: false, sleep: false, display: true, selfClean: false, filter: false, humidity: null,
  watts: null, kwh: null, errorCode: 0,
  ...over,
});
const fresh = () => new HistoryLog(join(mkdtempSync(join(tmpdir(), "mideabar-")), "history.json"));
const T0 = new Date(2026, 9, 11, 8, 0).getTime();
/** Feed one reading a minute from `from` to `to` (minutes after T0), with the room given by `room(minute)`. */
function feed(log: HistoryLog, from: number, to: number, room: (m: number) => number, over: Partial<AcState> = {}) {
  for (let m = from; m <= to; m++) log.record(state({ indoor: room(m), ...over }), T0 + m * MIN);
}
const keys = (r: { notify: { key: string }[] }) => r.notify.map((a) => a.key);

test("keeps a reading every two minutes, and every change of state", () => {
  const log = fresh();
  feed(log, 0, 10, () => 18);
  assert.equal(log.recent(24, T0 + 10 * MIN).length, 6);
  log.record(state({ target: 23 }), T0 + 10.5 * MIN);
  log.record(state({ target: 23, power: false }), T0 + 10.6 * MIN);
  assert.equal(log.recent(24, T0 + 11 * MIN).length, 8);
});

test("drops readings older than two days and survives a restart", () => {
  const log = fresh();
  log.record(state(), T0);
  log.record(state(), T0 + 49 * HOUR);
  assert.equal(log.recent(100, T0 + 49 * HOUR).length, 1);
  log.save(true);
  assert.equal(new HistoryLog(log.path).recent(100, T0 + 49 * HOUR).length, 1);
});

test("knows since when the unit has been on, and since when at this target", () => {
  const log = fresh();
  log.record(state({ power: false }), T0);
  feed(log, 10, 60, () => 18);
  feed(log, 61, 90, () => 19, { target: 24 });
  const run = log.run(T0 + 90 * MIN);
  assert.equal(run.onSince, T0 + 10 * MIN);
  assert.equal(run.settledSince, T0 + 61 * MIN);
  log.record(state({ power: false }), T0 + 91 * MIN);
  assert.deepEqual(log.run(T0 + 92 * MIN), { onSince: null, settledSince: null });
});

test("trend reports running time, the room's range and how long it took to reach the target", () => {
  const log = fresh();
  // Heating from 18° at one degree every ten minutes: within half a degree of 22° after 35 minutes.
  feed(log, 0, 120, (m) => Math.min(22, 18 + m / 10));
  log.record(state({ power: false, indoor: 22 }), T0 + 121 * MIN);
  log.record(state({ power: false, indoor: 21 }), T0 + 180 * MIN);
  let trend = log.trend(T0 + 180 * MIN);
  assert.ok(Math.abs(trend.ranMinutes - 121) < 1, `ran ${trend.ranMinutes}`);
  assert.equal(trend.roomMin, 18);
  assert.equal(trend.roomMax, 22);
  assert.equal(trend.reached, null, "off now, so nothing to report against a target");
  assert.ok(trend.points.length < 60, "thinned for drawing");

  trend = log.trend(T0 + 120 * MIN);
  assert.equal(trend.reached?.there, true);
  assert.equal(trend.reached?.target, 22);
  assert.ok(Math.abs(trend.reached!.minutes - 36) <= 2, `reached in ${trend.reached!.minutes}`);

  trend = log.trend(T0 + 20 * MIN);
  assert.deepEqual({ there: trend.reached?.there, minutes: Math.round(trend.reached!.minutes) }, { there: false, minutes: 20 });
});

test("says nothing while all is well", () => {
  const log = fresh();
  feed(log, 0, 90, (m) => Math.min(22, 18 + m / 10));
  const r = checkAlerts("Bedroom", state({ indoor: 22 }), log, {}, T0 + 90 * MIN);
  assert.deepEqual(r, { active: [], notify: [] });
});

test("a fault is announced once, and again only if the code changes", () => {
  const log = fresh();
  const marks: Record<string, number> = {};
  feed(log, 0, 4, () => 20);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ errorCode: 12 }), log, marks, T0 + 4 * MIN)), ["fault"]);
  const again = checkAlerts("Bedroom", state({ errorCode: 12 }), log, marks, T0 + 5 * MIN);
  assert.deepEqual(keys(again), []);
  assert.equal(again.active[0]?.severity, "problem");
  assert.match(again.active[0]!.body, /Fault code 12/);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ errorCode: 7 }), log, marks, T0 + 6 * MIN)), ["fault"]);
  checkAlerts("Bedroom", state(), log, marks, T0 + 7 * MIN);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ errorCode: 7 }), log, marks, T0 + 8 * MIN)), ["fault"], "cleared, then back");
});

test("a dirty filter is announced at most once a week, even across restarts", () => {
  const log = fresh();
  const marks: Record<string, number> = {};
  const dirty = state({ filter: true, power: false });
  assert.deepEqual(keys(checkAlerts("Bedroom", dirty, log, marks, T0)), ["filter"]);
  const saved = JSON.parse(JSON.stringify(marks));
  const later = checkAlerts("Bedroom", dirty, log, saved, T0 + 3 * 24 * HOUR);
  assert.deepEqual(keys(later), []);
  assert.equal(later.active.length, 1, "still shown in the popover");
  assert.deepEqual(keys(checkAlerts("Bedroom", dirty, log, saved, T0 + 8 * 24 * HOUR)), ["filter"]);
});

test("left on for eight hours: one nudge per stretch", () => {
  const log = fresh();
  const marks: Record<string, number> = {};
  feed(log, 0, 8 * 60 + 5, () => 22);
  const now = T0 + (8 * 60 + 5) * MIN;
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 22 }), log, marks, T0 + 7 * HOUR)), []);
  const r = checkAlerts("Bedroom", state({ indoor: 22 }), log, marks, now);
  assert.deepEqual(keys(r), ["long-run"]);
  assert.match(r.notify[0]!.title, /Bedroom has been on for 8 hours/);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 22 }), log, marks, now + MIN)), []);
});

test("an hour of heating with the room going nowhere suggests an open window", () => {
  const log = fresh();
  const marks: Record<string, number> = {};
  feed(log, 0, 61, () => 18.2);
  const r = checkAlerts("Bedroom", state({ indoor: 18.2 }), log, marks, T0 + 61 * MIN);
  assert.deepEqual(keys(r), ["stalled"]);
  assert.equal(r.notify[0]!.title, "The room is not getting warmer");
  assert.match(r.notify[0]!.body, /still 18\.2°, 4° from the target/);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 18.2 }), log, marks, T0 + 62 * MIN)), []);
});

test("no open-window alarm when the room is making progress, is nearly there, or nobody was watching", () => {
  // Slow but real progress: 1.5° in an hour.
  let log = fresh();
  feed(log, 0, 61, (m) => 18 + m / 40);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 19.5 }), log, {}, T0 + 61 * MIN)), []);

  // Stuck, but only 1.5° short: that is a unit at its limit on a cold day, not a window.
  log = fresh();
  feed(log, 0, 61, () => 20.5);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 20.5 }), log, {}, T0 + 61 * MIN)), []);

  // The Mac slept for most of the hour.
  log = fresh();
  feed(log, 0, 5, () => 18.2);
  feed(log, 58, 61, () => 18.2);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 18.2 }), log, {}, T0 + 61 * MIN)), []);

  // The target was just changed: the clock starts again.
  log = fresh();
  feed(log, 0, 61, () => 18.2);
  log.record(state({ indoor: 18.2, target: 24 }), T0 + 62 * MIN);
  assert.deepEqual(keys(checkAlerts("Bedroom", state({ indoor: 18.2, target: 24 }), log, {}, T0 + 63 * MIN)), []);
});

test("cooling stalls are worded for cooling", () => {
  const log = fresh();
  feed(log, 0, 61, () => 29, { mode: "cool", target: 24 });
  const r = checkAlerts("Living room", state({ mode: "cool", target: 24, indoor: 29 }), log, {}, T0 + 61 * MIN);
  assert.equal(r.notify[0]?.title, "The room is not getting cooler");
});
