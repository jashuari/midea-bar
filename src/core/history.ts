import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { AcState, Mode, Trend, TrendPoint } from "./types";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
/** Keep two days, so a full 24 hours is always available. */
const KEEP_MS = 48 * HOUR;
/** A reading is kept this often even when nothing changed. */
const EVERY_MS = 2 * MINUTE;
/** Readings further apart than this mean the app was not watching. */
export const WATCH_GAP_MS = 10 * MINUTE;
/** "At the target" means within this many degrees of it. */
const CLOSE_ENOUGH = 0.5;

/** One reading of the unit. Short keys, because thousands of these are stored. */
export interface Sample {
  t: number;
  /** Room and outside temperature. */
  i: number | null;
  o: number | null;
  /** Target temperature, whether the unit is on, and its mode. */
  g: number;
  on: boolean;
  m: Mode;
}

/** How far the room still has to go, in the direction the unit is pushing. Zero or less means it is there. */
export function gap(mode: Mode, indoor: number, target: number): number {
  if (mode === "cool" || mode === "dry") return indoor - target;
  if (mode === "heat") return target - indoor;
  return Math.abs(indoor - target);
}

/**
 * A rolling record of room, outside and target temperature.
 * Feeds the 24-hour chart and the "something is off" notifications.
 */
export class HistoryLog {
  private samples: Sample[];
  private dirty = false;
  private lastWrite = 0;

  constructor(readonly path: string) {
    this.samples = this.read();
  }

  private read(): Sample[] {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as unknown;
      return Array.isArray(raw) ? (raw as Sample[]).filter((s) => typeof s?.t === "number") : [];
    } catch {
      return [];
    }
  }

  save(force = false): void {
    if (!this.dirty || (!force && Date.now() - this.lastWrite < 5 * MINUTE)) return;
    try {
      mkdirSync(dirname(this.path), { recursive: true });
      const tmp = `${this.path}.tmp`;
      writeFileSync(tmp, JSON.stringify(this.samples));
      renameSync(tmp, this.path);
      this.dirty = false;
      this.lastWrite = Date.now();
    } catch {
      // History is a convenience; never let it get in the way.
    }
  }

  /** Feed in a reading. It is kept if something changed or enough time has passed. */
  record(s: AcState, now = Date.now()): void {
    const last = this.samples.at(-1);
    const changed = !last || last.on !== s.power || last.g !== s.target || last.m !== s.mode;
    if (!changed && now - last.t < EVERY_MS) return;
    if (last && now <= last.t) return;

    this.samples.push({ t: now, i: s.indoor, o: s.outdoor, g: s.target, on: s.power, m: s.mode });
    const cutoff = now - KEEP_MS;
    while (this.samples.length > 0 && this.samples[0]!.t < cutoff) this.samples.shift();
    this.dirty = true;
  }

  /** Readings from the last `hours`, oldest first. */
  recent(hours: number, now = Date.now()): Sample[] {
    const from = now - hours * HOUR;
    return this.samples.filter((s) => s.t >= from && s.t <= now);
  }

  /**
   * The stretch the unit is in right now: since when it has been on without a
   * break, and since when it has been working towards the current target.
   */
  run(now = Date.now()): { onSince: number | null; settledSince: number | null } {
    const all = this.samples.filter((s) => s.t <= now);
    const last = all.at(-1);
    if (!last?.on) return { onSince: null, settledSince: null };

    let onSince = last.t;
    let settledSince = last.t;
    let settled = true;
    for (let k = all.length - 1; k >= 0; k--) {
      const s = all[k]!;
      if (!s.on) break;
      onSince = s.t;
      if (settled && s.g === last.g && s.m === last.m) settledSince = s.t;
      else settled = false;
    }
    return { onSince, settledSince };
  }

  /** The reading closest to `ago` before now, if the app was watching around then. */
  around(ago: number, now = Date.now()): Sample | null {
    const at = now - ago;
    let best: Sample | null = null;
    for (const s of this.samples) {
      if (s.t > now) break;
      if (!best || Math.abs(s.t - at) < Math.abs(best.t - at)) best = s;
    }
    return best && Math.abs(best.t - at) <= WATCH_GAP_MS ? best : null;
  }

  /** True if readings arrived without a long break over the last `span`. */
  watched(span: number, now = Date.now()): boolean {
    const since = this.samples.filter((s) => s.t >= now - span && s.t <= now);
    if (since.length < 2 || since[0]!.t > now - span + WATCH_GAP_MS) return false;
    for (let k = 1; k < since.length; k++) if (since[k]!.t - since[k - 1]!.t > WATCH_GAP_MS) return false;
    return now - since.at(-1)!.t <= WATCH_GAP_MS;
  }

  /** Everything the 24-hour view shows. */
  trend(now = Date.now()): Trend {
    const samples = this.recent(24, now);

    // Thin to at most ~290 points: one per five minutes, plus every change of state.
    const points: TrendPoint[] = [];
    let lastKept: Sample | null = null;
    for (const s of samples) {
      const changed = !lastKept || lastKept.on !== s.on || lastKept.g !== s.g;
      if (!changed && s.t - lastKept!.t < 5 * MINUTE && s !== samples.at(-1)) continue;
      points.push({ t: s.t, indoor: s.i, outdoor: s.o, target: s.g, on: s.on });
      lastKept = s;
    }

    // Time running: each reading speaks for the time until the next one.
    let ranMs = 0;
    for (let k = 0; k < samples.length; k++) {
      const next = samples[k + 1]?.t ?? Math.min(now, samples[k]!.t + EVERY_MS);
      if (samples[k]!.on) ranMs += next - samples[k]!.t;
    }

    const rooms = samples.map((s) => s.i).filter((v): v is number => v !== null);
    const { settledSince } = this.run(now);
    const last = samples.at(-1);

    // How long the room took to get to the current target, if it has.
    let reached: Trend["reached"] = null;
    if (last?.on && settledSince !== null && last.m !== "fan" && last.i !== null) {
      const stretch = samples.filter((s) => s.t >= settledSince && s.i !== null);
      const first = stretch[0];
      const arrived = stretch.find((s) => gap(s.m, s.i!, s.g) <= CLOSE_ENOUGH);
      if (first && gap(first.m, first.i!, first.g) > CLOSE_ENOUGH) {
        reached = arrived
          ? { target: last.g, minutes: (arrived.t - settledSince) / MINUTE, there: true }
          : { target: last.g, minutes: (now - settledSince) / MINUTE, there: false };
      }
    }

    return {
      points,
      ranMinutes: ranMs / MINUTE,
      roomMin: rooms.length ? Math.min(...rooms) : null,
      roomMax: rooms.length ? Math.max(...rooms) : null,
      reached,
    };
  }
}
