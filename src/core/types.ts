/** Shared types between the controller, the CLI, the main process and the popover. */

export type Mode = "auto" | "cool" | "dry" | "heat" | "fan";
export type Fan = "auto" | "silent" | "low" | "medium" | "high" | "max";
export type Swing = "off" | "vertical" | "horizontal" | "both";

export interface AcState {
  power: boolean;
  mode: Mode;
  /** Target temperature, °C. */
  target: number;
  /** Measured room temperature, °C. Null when the unit does not report it. */
  indoor: number | null;
  outdoor: number | null;
  fan: Fan;
  swing: Swing;
  eco: boolean;
  turbo: boolean;
  sleep: boolean;
  /** The unit's front display light. Only meaningful when caps.display is true. */
  display: boolean;
  /** A self-clean cycle is running. */
  selfClean: boolean;
  /** The unit says its filter needs cleaning. */
  filter: boolean;
  /** Room humidity in percent. Null when the unit has no sensor. */
  humidity: number | null;
  /** Power draw right now, in watts. Null when the unit does not report it. */
  watts: number | null;
  /** Lifetime energy use, in kWh. Null when the unit does not report it. */
  kwh: number | null;
  /** Non-zero when the unit reports a fault. */
  errorCode: number;
}

export interface AcCaps {
  minTemp: number;
  maxTemp: number;
  modes: Mode[];
  fans: Fan[];
  swings: Swing[];
  eco: boolean;
  turbo: boolean;
  /** Smallest temperature change the unit honours. */
  step: 0.5 | 1;
  display: boolean;
  selfClean: boolean;
  energy: boolean;
}

/** What gets written to disk for each air conditioner. */
export interface DeviceRecord {
  id: number;
  ip: string;
  port: number;
  /** Network name reported by the unit, e.g. net_ac_63BA. */
  name: string;
  sn: string;
  /** LAN protocol version: 2 needs no credentials, 3 needs token + key. */
  version: number;
  token?: string;
  key?: string;
  /** Name the user gave it. */
  label?: string;
  /** Learned: this unit ignores half degrees, so only offer whole ones. */
  wholeDegrees?: boolean;
  /**
   * Learned by asking once: whether the unit reports its own energy use even
   * though its capability list does not say so. Undefined until it has been asked.
   */
  meters?: boolean;
}

/** How to turn the unit's energy use into money. */
export interface Electricity {
  /** KESCO household meter: one price all day, or cheaper at night. */
  meter: "single" | "dual";
  /**
   * 1: the household stays under 800 kWh a month. 2: it goes over, so the AC's
   * use is billed at the higher rate. "winter": it goes over from October to
   * May and stays under from June to September, as a home heated by electricity does.
   */
  block: 1 | 2 | "winter";
  /** Add 8% VAT to the published prices. */
  vat: boolean;
  /** The unit's rated input power in watts, from its nameplate. Only needed when the unit does not meter itself. */
  ratedWatts: number | null;
}

export interface CostFigure {
  kwh: number;
  /** Euros. */
  cost: number;
  /** Minutes the unit ran. */
  minutes: number;
}

export interface CostSummary {
  /** True when the unit reports its own energy use; false when the figures are estimates. */
  metered: boolean;
  /** An estimate is impossible until the user enters the unit's rated power. */
  needsRating: boolean;
  today: CostFigure;
  month: CostFigure;
  /** Minutes this month that were assumed because the app was not watching. */
  assumedMinutes: number;
  /** The last 14 days, oldest first. */
  days: { date: string; kwh: number; cost: number }[];
  /** Price in effect, euro cents per kWh. */
  cents: { high: number; low: number };
  settings: Electricity;
}

export interface TrendPoint {
  t: number;
  indoor: number | null;
  outdoor: number | null;
  target: number;
  on: boolean;
}

/** The last 24 hours of temperatures, for the chart. */
export interface Trend {
  points: TrendPoint[];
  /** Minutes the unit ran in the last 24 hours. */
  ranMinutes: number;
  roomMin: number | null;
  roomMax: number | null;
  /**
   * How the room is doing against the current target: `there` with how long it
   * took, or not there yet with how long it has been trying. Null when the room
   * was already at the target, or the unit is off.
   */
  reached: { target: number; minutes: number; there: boolean } | null;
}

/** Something worth telling the user about. */
export interface Alert {
  key: "fault" | "filter" | "long-run" | "stalled";
  /** A problem needs attention; a note is a nudge. */
  severity: "problem" | "note";
  title: string;
  body: string;
}

export interface Config {
  devices: DeviceRecord[];
  selectedId: number | null;
  beep: boolean;
  /** Energy figures come in two encodings and units do not say which they use. */
  energyBinary: boolean;
  /** When the off timer fires (epoch ms) and for which unit. */
  offAt: number | null;
  offId: number | null;
  electricity: Electricity;
  /** Show macOS notifications for alerts. */
  notify: boolean;
  /** What was last announced for each alert, so a restart does not repeat it. */
  alerted: Record<string, number>;
}

/**
 * needs-account: a unit was found, but Midea only releases its key to the
 * SmartHome account that owns it, so the owner has to sign in once.
 */
export type Status = "ready" | "offline" | "no-device" | "scanning" | "needs-account";

export interface Snapshot {
  status: Status;
  /** Plain-language reason, set when status is offline, a scan found nothing, or a sign-in failed. */
  message?: string;
  device: { id: number; label: string; ip: string } | null;
  devices: { id: number; label: string }[];
  state: AcState | null;
  caps: AcCaps | null;
  /** When the off timer will switch the current unit off (epoch ms), if one is set. */
  offAt: number | null;
  /** What the unit has cost to run. Added by the menu bar app, which keeps the usage log. */
  cost?: CostSummary;
  /** Room temperature over the last 24 hours, thinned for the small chart on the main view. */
  spark?: { values: number[]; min: number; max: number };
  /** What currently needs attention. */
  alerts?: Alert[];
}

export type Patch = Partial<
  Pick<AcState, "power" | "mode" | "target" | "fan" | "swing" | "eco" | "turbo" | "sleep" | "display">
>;
