import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { centsPerKwh, cost, isHighTariff } from "./tariff";
import type { AcState, CostSummary, Electricity } from "./types";

const HOUR = 3_600_000;
/** Samples further apart than this mean the app was not watching (closed, or the Mac asleep). */
const WATCH_GAP_MS = 3 * 60_000;
/** Longest stretch we will assume the unit kept running unobserved. */
const ASSUME_MAX_MS = 24 * HOUR;
/** A meter jump bigger than this between two readings is a reset or a glitch, not use. */
const SANE_DELTA_KWH = 300;

/**
 * How hard the unit is probably working, as a share of its rated input power.
 *
 * Only used for units that do not meter themselves. An inverter compressor
 * runs flat out while the room is far from the target and idles at roughly a
 * quarter of its rating once it gets there, so the gap between room and target
 * is the best signal available. This is a rough model: expect the result to be
 * off by a third either way.
 */
export function estimateLoad(s: AcState): number {
  if (!s.power) return 0;
  if (s.mode === "fan") return 0.05;
  if (s.mode === "dry") return 0.35;
  if (s.turbo) return 1;
  if (s.indoor === null) return 0.6;

  const gap =
    s.mode === "cool" ? s.indoor - s.target : s.mode === "heat" ? s.target - s.indoor : Math.abs(s.indoor - s.target);
  const load = 0.25 + 0.75 * Math.min(1, Math.max(0, gap / 3));
  return s.eco ? load * 0.85 : load;
}

/** One local calendar day of use. */
interface Day {
  /** Metered kWh in high- and low-tariff hours. */
  high: number;
  low: number;
  /** Estimated use for unmetered units: load share × hours. Multiply by rated kW for kWh. */
  loadHigh: number;
  loadLow: number;
  /** Minutes the unit ran, and how many of those were assumed while nobody was watching. */
  minutes: number;
  assumed: number;
}

interface Last {
  ts: number;
  on: boolean;
  /** The unit's own lifetime meter, if it has one. */
  kwh: number | null;
  load: number;
}

interface Data {
  days: Record<string, Day>;
  last: Last | null;
}

const dayKey = (d: Date) =>
  `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;

const emptyDay = (): Day => ({ high: 0, low: 0, loadHigh: 0, loadLow: 0, minutes: 0, assumed: 0 });

/**
 * A running log of how much the unit used, per day and per tariff period.
 *
 * It stores energy, not money, so changing the tariff settings or the rated
 * power re-prices the whole history.
 */
export class UsageLog {
  private data: Data;
  private dirty = false;
  private lastWrite = 0;

  constructor(readonly path: string) {
    this.data = this.read();
  }

  private read(): Data {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Data>;
      return { days: raw.days && typeof raw.days === "object" ? raw.days : {}, last: raw.last ?? null };
    } catch {
      return { days: {}, last: null };
    }
  }

  /** Write to disk if anything changed. Throttled unless `force` is set. */
  save(force = false): void {
    if (!this.dirty || (!force && Date.now() - this.lastWrite < 60_000)) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.data));
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastWrite = Date.now();
    } catch {
      // Losing a minute of usage history is not worth bothering anyone about.
    }
  }

  /** Feed in a fresh reading of the unit. Call it every time one arrives. */
  record(state: AcState, now = Date.now()): void {
    const prev = this.data.last;
    this.data.last = { ts: now, on: state.power, kwh: state.kwh, load: estimateLoad(state) };
    this.dirty = true;
    if (!prev || now <= prev.ts) return;

    const dt = now - prev.ts;
    const watched = dt <= WATCH_GAP_MS;

    if (state.kwh !== null && prev.kwh !== null) {
      // The unit meters itself: the difference is exact however long we looked away.
      const delta = state.kwh - prev.kwh;
      if (delta > 0 && delta < SANE_DELTA_KWH) this.spread(prev.ts, now, { kwh: delta });
      if (prev.on && watched) this.spread(prev.ts, now, { ran: true });
      return;
    }

    if (watched) {
      if (prev.on) this.spread(prev.ts, now, { load: prev.load, ran: true });
      return;
    }

    // Nobody was watching. If it was on before and is on now, assume it ran
    // throughout; if it has since been switched off, assume that happened halfway.
    if (!prev.on) return;
    const assumedFor = Math.min(state.power ? dt : dt / 2, ASSUME_MAX_MS);
    this.spread(prev.ts, prev.ts + assumedFor, { load: prev.load, ran: true, assumed: true });
  }

  /** Share something evenly over a stretch of time, hour by hour, into the right day and tariff period. */
  private spread(
    from: number,
    to: number,
    what: { kwh?: number; load?: number; ran?: boolean; assumed?: boolean },
  ): void {
    const total = to - from;
    if (total <= 0) return;
    let t = from;
    while (t < to) {
      const at = new Date(t);
      const nextHour = new Date(at.getFullYear(), at.getMonth(), at.getDate(), at.getHours() + 1).getTime();
      const end = Math.min(to, nextHour);
      const span = end - t;
      const day = (this.data.days[dayKey(at)] ??= emptyDay());
      const high = isHighTariff(at);

      if (what.kwh) day[high ? "high" : "low"] += what.kwh * (span / total);
      if (what.load) day[high ? "loadHigh" : "loadLow"] += what.load * (span / HOUR);
      if (what.ran) day.minutes += span / 60_000;
      if (what.assumed) day.assumed += span / 60_000;
      t = end;
    }
  }

  /** Today, this month and the last two weeks, priced with the given settings. */
  summary(e: Electricity, now = new Date()): CostSummary {
    const kw = (e.ratedWatts ?? 0) / 1000;
    // Each day is priced at the rate in force on that day, which matters when the block changes with the season.
    const price = (key: string, d: Day) => {
      const [y, m, day] = key.split("-").map(Number);
      const high = d.high + d.loadHigh * kw;
      const low = d.low + d.loadLow * kw;
      return { kwh: high + low, cost: cost(high, low, e, new Date(y!, m! - 1, day!)), minutes: d.minutes };
    };
    const add = (a: { kwh: number; cost: number; minutes: number }, key: string) => {
      const d = this.data.days[key];
      if (!d) return a;
      const p = price(key, d);
      return { kwh: a.kwh + p.kwh, cost: a.cost + p.cost, minutes: a.minutes + p.minutes };
    };
    const zero = { kwh: 0, cost: 0, minutes: 0 };

    const today = dayKey(now);
    const monthPrefix = today.slice(0, 8);
    let month = zero;
    let assumed = 0;
    for (const [key, d] of Object.entries(this.data.days)) {
      if (!key.startsWith(monthPrefix)) continue;
      month = add(month, key);
      assumed += d.assumed;
    }

    const days = [];
    for (let i = 13; i >= 0; i--) {
      const date = dayKey(new Date(now.getFullYear(), now.getMonth(), now.getDate() - i));
      const p = add(zero, date);
      days.push({ date, kwh: p.kwh, cost: p.cost });
    }

    const metered = this.data.last?.kwh != null;
    return {
      metered,
      needsRating: !metered && !e.ratedWatts,
      today: add(zero, today),
      month,
      assumedMinutes: assumed,
      days,
      cents: centsPerKwh(e, now),
      settings: e,
    };
  }
}
