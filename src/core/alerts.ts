import { gap, type HistoryLog } from "./history";
import type { AcState, Alert } from "./types";

const HOUR = 3_600_000;
/** Remind about a dirty filter at most this often. */
const FILTER_EVERY_MS = 7 * 24 * HOUR;
/** "Has it been left on?" */
const LONG_RUN_MS = 8 * HOUR;
/** How long the unit gets to make a difference before we say it is not. */
const STALL_AFTER_MS = HOUR;
/** Still this far from the target… */
const STALL_GAP = 2;
/** …and less than this much closer than an hour ago. */
const STALL_PROGRESS = 0.5;

const degrees = (t: number) => `${Number.isInteger(t) ? t : t.toFixed(1)}°`;

/**
 * Decides what is worth telling the user about, and when it is new enough to
 * interrupt them with.
 *
 * `active` is everything currently true, for showing in the popover.
 * `notify` is the subset that has not been announced yet. `marks` records what
 * was last announced per alert, so a restart does not repeat it; the caller
 * persists it.
 */
export function checkAlerts(
  name: string,
  state: AcState,
  history: HistoryLog,
  marks: Record<string, number>,
  now = Date.now(),
): { active: Alert[]; notify: Alert[] } {
  const active: Alert[] = [];
  const notify: Alert[] = [];
  /** Raise an alert; announce it unless this same occurrence already was. */
  const raise = (alert: Alert, occurrence: number, repeatAfter?: number) => {
    active.push(alert);
    const last = marks[alert.key];
    const fresh = repeatAfter === undefined ? last !== occurrence : last === undefined || now - last >= repeatAfter;
    if (!fresh) return;
    marks[alert.key] = repeatAfter === undefined ? occurrence : now;
    notify.push(alert);
  };

  if (state.errorCode) {
    raise(
      {
        key: "fault",
        severity: "problem",
        title: `${name} reports a fault`,
        body: `Fault code ${state.errorCode}. Check the unit's display or the SmartHome app.`,
      },
      state.errorCode,
    );
  } else {
    delete marks.fault;
  }

  if (state.filter) {
    raise(
      {
        key: "filter",
        severity: "note",
        title: "Time to clean the filter",
        body: `${name} says its filter needs cleaning. A clogged filter makes it run longer for the same result.`,
      },
      0,
      FILTER_EVERY_MS,
    );
  }

  const { onSince, settledSince } = history.run(now);
  if (!state.power || onSince === null || settledSince === null) return { active, notify };

  if (now - onSince >= LONG_RUN_MS) {
    const doing =
      state.mode === "heat" ? `heating to ${degrees(state.target)}` : state.mode === "cool" ? `cooling to ${degrees(state.target)}` : "running";
    raise(
      {
        key: "long-run",
        severity: "note",
        title: `${name} has been on for ${Math.floor((now - onSince) / HOUR)} hours`,
        body: `Still ${doing}. Switch it off from the menu bar if nobody needs it.`,
      },
      onSince,
    );
  }

  // Working hard and getting nowhere: the classic open window. Only judged when
  // the app has been watching the whole hour, so a nap is never mistaken for a draught.
  const heatingOrCooling = state.mode === "heat" || state.mode === "cool";
  if (heatingOrCooling && state.indoor !== null && now - settledSince >= STALL_AFTER_MS && history.watched(STALL_AFTER_MS, now)) {
    const before = history.around(STALL_AFTER_MS, now);
    const left = gap(state.mode, state.indoor, state.target);
    if (before && before.i !== null && before.on && left >= STALL_GAP) {
      const progress = gap(before.m, before.i, before.g) - left;
      if (progress < STALL_PROGRESS) {
        raise(
          {
            key: "stalled",
            severity: "note",
            title: `The room is not getting ${state.mode === "heat" ? "warmer" : "cooler"}`,
            body: `${name} has run for an hour and the room is still ${degrees(state.indoor)}, ${degrees(Math.round(left * 2) / 2)} from the target. A window or door may be open.`,
          },
          settledSince,
        );
      }
    }
  }

  return { active, notify };
}
