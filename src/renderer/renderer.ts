import type { AcState, CostSummary, Electricity, Fan, Mode, Patch, Snapshot, Swing, Trend, TrendPoint } from "../core/types";
import type { Api } from "../main/preload";

declare global {
  interface Window {
    ac: Api;
  }
}

const ac = window.ac;
const $ = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

const MODE_LABEL: Record<Mode, string> = { auto: "Auto", cool: "Cool", dry: "Dry", heat: "Heat", fan: "Fan" };
const DOING: Record<Mode, string> = {
  auto: "Automatic, set to",
  cool: "Cooling to",
  dry: "Drying, set to",
  heat: "Heating to",
  fan: "Fan only",
};
const FAN_LABEL: Record<Fan, string> = {
  auto: "Auto",
  silent: "Silent",
  low: "Low",
  medium: "Mid",
  high: "High",
  max: "Max",
};
const SWING_LABEL: Record<Swing, [text: string, spoken: string]> = {
  off: ["Off", "Off"],
  vertical: ["↕", "Up and down"],
  horizontal: ["↔", "Left and right"],
  both: ["Both", "Both directions"],
};
/** Off timer choices, in minutes. */
const TIMER_CHOICES: [minutes: number, label: string][] = [
  [30, "30 min"],
  [60, "1 h"],
  [120, "2 h"],
  [240, "4 h"],
  [480, "8 h"],
];

/** Wait this long after the last +/− press before sending, so five presses are one command. */
const TEMP_DEBOUNCE_MS = 450;
/** The slider's fill never gets narrower than this, so the number always sits on it. */
const FILL_MIN_PX = 104;

const EMPTY: Omit<Snapshot, "status"> = { device: null, devices: [], state: null, caps: null, offAt: null };

let snap: Snapshot | null = null;
/** What the controls show: the unit's state plus changes not yet confirmed. */
let shown: AcState | null = null;
let pending: Patch = {};
let inFlight = 0;
let timer: number | undefined;
let choosingTimer = false;
let dragging = false;
/** Showing the electricity panel instead of the controls. */
let showingBill = false;
/** Showing the 24-hour chart instead of the controls, and the data for it. */
let showingTrend = false;
let trend: Trend | null = null;
/** Index of the chart point the crosshair sits on; null means "latest". */
let probe: number | null = null;

const busy = () => inFlight > 0 || Object.keys(pending).length > 0 || dragging;
const degrees = (t: number | null) => (t === null ? "–" : `${Number.isInteger(t) ? t : t.toFixed(1)}°`);

// ── Sending changes ─────────────────────────────────────────────────────────

function change(patch: Patch, delay = 0): void {
  if (!shown) return;
  shown = { ...shown, ...patch };
  if (patch.eco) shown.turbo = false;
  if (patch.turbo) shown.eco = false;
  pending = { ...pending, ...patch };
  render();
  window.clearTimeout(timer);
  timer = window.setTimeout(flush, delay);
}

async function flush(): Promise<void> {
  const patch = pending;
  pending = {};
  inFlight++;
  let result: Snapshot | null = null;
  try {
    result = await ac.set(patch);
  } finally {
    inFlight--;
  }
  // Only take the unit's answer once nothing newer is queued behind it.
  if (result && !busy()) accept(result);
}

function accept(next: Snapshot): void {
  snap = next;
  shown = next.state ? { ...next.state } : null;
  render();
}

// ── Building blocks ─────────────────────────────────────────────────────────

/** Rebuild a group of buttons without dropping keyboard focus from it. */
function replaceKeepingFocus(host: HTMLElement, children: HTMLElement[]): void {
  const focused = [...host.children].indexOf(document.activeElement as Element);
  host.replaceChildren(...children);
  if (focused >= 0) children[Math.min(focused, children.length - 1)]?.focus();
}

function icon(name: string): SVGSVGElement {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  svg.setAttribute("aria-hidden", "true");
  return svg;
}

/** A round icon button with a caption under it. */
function round(iconName: string, caption: string, click: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.className = "round";
  const disc = document.createElement("span");
  disc.className = "disc";
  disc.append(icon(iconName));
  const text = document.createElement("span");
  text.textContent = caption;
  b.append(disc, text);
  b.addEventListener("click", click);
  return b;
}

function segments<T extends string>(
  host: HTMLElement,
  options: T[],
  current: T,
  label: (value: T) => [text: string, spoken?: string],
  pick: (value: T) => void,
): void {
  replaceKeepingFocus(
    host,
    options.map((value) => {
      const [text, spoken] = label(value);
      const b = document.createElement("button");
      b.textContent = text;
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(value === current));
      if (spoken && spoken !== text) {
        b.setAttribute("aria-label", spoken);
        b.title = spoken;
      }
      b.addEventListener("click", () => value !== current && pick(value));
      return b;
    }),
  );
}

function remaining(until: number): string {
  const minutes = Math.max(1, Math.round((until - Date.now()) / 60_000));
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return h === 0 ? `${m} min` : m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// ── Electricity ─────────────────────────────────────────────────────────────

const euros = (n: number) => `€${n.toFixed(2)}`;
const kwh = (n: number) => `${n < 10 ? n.toFixed(1) : Math.round(n)} kWh`;
const hours = (minutes: number) => (minutes < 60 ? `${Math.round(minutes)} min` : `${(minutes / 60).toFixed(1)} h`);
const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];
const localDate = (key: string) => {
  const [y, m, d] = key.split("-").map(Number);
  return new Date(y!, m! - 1, d!);
};

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className: string, text = ""): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/** What it has cost: today and this month, as the right-hand door under the controls. */
function renderCostTile(c: CostSummary | undefined): void {
  const tile = $("cost");
  tile.hidden = !c;
  if (!c) return;

  if (c.needsRating) {
    tile.replaceChildren(el("span", "ask", "Add your unit's rated power to see what it costs"));
    return;
  }
  const approx = c.metered ? "" : "≈ ";
  const line = (when: string, f: { cost: number }) => {
    const row = el("div", "line");
    row.append(el("span", "when", when), el("span", "money", `${approx}${euros(f.cost)}`));
    return row;
  };
  tile.replaceChildren(line("Today", c.today), line(new Date().toLocaleDateString("en-GB", { month: "long" }), c.month));
}

/** A temperature range, compact: "17.5–22°". */
const span = (lo: number, hi: number) => (lo === hi ? degrees(lo) : `${degrees(lo).slice(0, -1)}–${degrees(hi)}`);

const SVG = "http://www.w3.org/2000/svg";
function svgEl(tag: string, attrs: Record<string, string | number>): SVGElement {
  const node = document.createElementNS(SVG, tag);
  for (const [k, v] of Object.entries(attrs)) node.setAttribute(k, String(v));
  return node;
}

/** The room's last 24 hours as a bare line: the left-hand door under the controls. */
function renderSparkTile(spark: Snapshot["spark"]): void {
  const tile = $("spark");
  const top = el("div", "top");
  top.append(el("span", "when", "Room, 24 h"));
  if (!spark) {
    tile.replaceChildren(top, el("span", "when", "Collecting readings"));
    return;
  }
  top.append(el("span", "span", span(spark.min, spark.max)));
  const w = 120;
  const h = 20;
  const range = Math.max(0.5, spark.max - spark.min);
  const path = spark.values
    .map((v, i) => `${i ? "L" : "M"}${((i / (spark.values.length - 1)) * w).toFixed(1)} ${(h - 1 - ((v - spark.min) / range) * (h - 2)).toFixed(1)}`)
    .join("");
  const svg = svgEl("svg", { viewBox: `0 0 ${w} ${h}`, preserveAspectRatio: "none", "aria-hidden": "true" });
  svg.append(svgEl("path", { d: path, fill: "none", "vector-effect": "non-scaling-stroke" }));
  tile.replaceChildren(top, svg);
}

// ── The last 24 hours ───────────────────────────────────────────────────────

const clock = (t: number) => new Date(t).toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
/** A break this long between readings means nobody was watching; the lines stop rather than guess. */
const LINE_GAP_MS = 20 * 60_000;

function renderTrend(t: Trend): void {
  const plot = $("plot") as unknown as SVGSVGElement;
  const points = t.points;
  const enough = points.filter((p) => p.indoor !== null).length >= 2;
  $("plot-empty").hidden = enough;
  plot.style.display = enough ? "" : "none";
  $("readout").hidden = !enough;

  // Three figures: how long it ran, the room's range, and how it did against the target.
  const fact = (when: string, value: string, more = "") => {
    const box = el("div", "fact");
    box.append(el("div", "when", when), el("div", "value", value), el("div", "more", more));
    return box;
  };
  $("facts").replaceChildren(
    fact("Running", hours(t.ranMinutes), "of the last 24 h"),
    fact("Room", t.roomMin === null ? "–" : span(t.roomMin, t.roomMax!), "low to high"),
    t.reached
      ? t.reached.there
        ? fact(`To reach ${degrees(t.reached.target)}`, hours(t.reached.minutes), "after it was set")
        : fact(`Not at ${degrees(t.reached.target)} yet`, hours(t.reached.minutes), "and counting")
      : fact("Target", shown?.power && enough ? "Held" : "–", !shown?.power ? "unit is off" : enough ? "room was already there" : "not enough readings yet"),
  );
  if (!enough) return;

  const W = plot.clientWidth || 280;
  const H = 150;
  const m = { l: 24, r: 8, t: 8, b: 18 };
  const now = Date.now();
  const from = now - 24 * 3_600_000;
  const hasOut = points.some((p) => p.outdoor !== null);

  // One temperature axis for every series, padded and snapped to whole degrees.
  const all = points.flatMap((p) => [p.indoor, p.on ? p.target : null, p.outdoor]).filter((v): v is number => v !== null);
  let lo = Math.floor(Math.min(...all) - 0.5);
  let hi = Math.ceil(Math.max(...all) + 0.5);
  if (hi - lo < 4) { lo -= 1; hi += 1; }
  const x = (time: number) => m.l + ((time - from) / (now - from)) * (W - m.l - m.r);
  const y = (temp: number) => m.t + (1 - (temp - lo) / (hi - lo)) * (H - m.t - m.b);

  const nodes: SVGElement[] = [];
  // Recessive grid: three or four clean temperatures, and a tick every six hours.
  const stepY = [1, 2, 5, 10].find((s) => (hi - lo) / s <= 4) ?? 10;
  for (let v = Math.ceil(lo / stepY) * stepY; v <= hi; v += stepY) {
    nodes.push(svgEl("line", { class: "grid", x1: m.l, x2: W - m.r, y1: y(v), y2: y(v) }));
    const label = svgEl("text", { x: m.l - 5, y: y(v) + 3, "text-anchor": "end" });
    label.textContent = `${v}°`;
    nodes.push(label);
  }
  const firstTick = new Date(from);
  firstTick.setMinutes(0, 0, 0);
  firstTick.setHours(Math.ceil((firstTick.getHours() + 1) / 6) * 6);
  for (let tick = firstTick.getTime(); tick < now - 3_600_000; tick += 6 * 3_600_000) {
    const label = svgEl("text", { x: x(tick), y: H - 4, "text-anchor": "middle" });
    label.textContent = clock(tick);
    nodes.push(label);
  }

  /** A line through one value of each point, lifted wherever the app was not watching. */
  const line = (cls: string, pick: (p: TrendPoint) => number | null, stepped = false) => {
    let d = "";
    let prev: TrendPoint | null = null;
    for (const p of points) {
      const v = pick(p);
      if (v === null) { prev = null; continue; }
      const joined = prev !== null && p.t - prev.t <= LINE_GAP_MS;
      if (!joined) d += `M${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
      else if (stepped) d += `H${x(p.t).toFixed(1)}V${y(v).toFixed(1)}`;
      else d += `L${x(p.t).toFixed(1)} ${y(v).toFixed(1)}`;
      prev = p;
    }
    nodes.push(svgEl("path", { class: cls, d, "stroke-linejoin": "round", "stroke-linecap": "round" }));
  };

  // When it ran: a strip along the baseline.
  for (let k = 0; k < points.length; k++) {
    const p = points[k]!;
    if (!p.on) continue;
    const end = points[k + 1]?.t ?? now;
    if (end - p.t > LINE_GAP_MS && points[k + 1]) continue;
    nodes.push(svgEl("rect", { class: "ran", x: x(p.t), y: H - m.b - 3, width: Math.max(1, x(end) - x(p.t)), height: 3 }));
  }
  line("goal", (p) => (p.on ? p.target : null), true);
  if (hasOut) line("out", (p) => p.outdoor);
  line("room", (p) => p.indoor);

  // Crosshair: snaps to the nearest reading. At rest it sits on the latest one.
  const at = points[Math.min(probe ?? points.length - 1, points.length - 1)]!;
  nodes.push(svgEl("line", { class: "cross", x1: x(at.t), x2: x(at.t), y1: m.t, y2: H - m.b }));
  const dot = (cls: string, v: number | null) => {
    if (v === null) return;
    nodes.push(svgEl("circle", { class: `dot ${cls}`, cx: x(at.t), cy: y(v), r: 4 }));
  };
  if (hasOut) dot("at-out", at.outdoor);
  dot("at-room", at.indoor);
  plot.setAttribute("viewBox", `0 0 ${W} ${H}`);
  plot.setAttribute(
    "aria-label",
    `Room${hasOut ? ", outside" : ""} and target temperature over the last 24 hours. Use the left and right arrow keys to read values.`,
  );
  plot.replaceChildren(...nodes);

  // The readout is the legend and the tooltip in one: a key, a name, and the value under the crosshair.
  const item = (key: string, name: string, value: string) => {
    const box = el("span", "item");
    box.append(el("span", `key ${key}`), document.createTextNode(`${name} `), el("b", "", value));
    return box;
  };
  $("readout").replaceChildren(
    el("span", "at", probe === null ? `Now, ${clock(at.t)}` : `${new Date(at.t).toLocaleDateString("en-GB", { weekday: "short" })} ${clock(at.t)}`),
    item("room", "Room", degrees(at.indoor)),
    ...(hasOut ? [item("out", "Outside", degrees(at.outdoor))] : []),
    item("goal", "Target", at.on ? degrees(at.target) : "off"),
    item("ran", at.on ? "Running" : "Not running", ""),
  );
}

function renderBill(c: CostSummary): void {
  const now = new Date();
  const approx = c.metered ? "" : "≈ ";
  $("bill-month").textContent = `${now.toLocaleDateString("en-GB", { month: "long" })} so far`;
  $("bill-figure").textContent = c.needsRating ? "–" : `${approx}${euros(c.month.cost)}`;
  const rate =
    c.cents.high === c.cents.low
      ? `${c.cents.high.toFixed(2)} c/kWh`
      : `${c.cents.high.toFixed(2)} c by day, ${c.cents.low.toFixed(2)} c at night`;
  $("bill-sub").textContent = c.needsRating
    ? `${hours(c.month.minutes)} running. Enter the rated power below to price it.`
    : `${kwh(c.month.kwh)} over ${hours(c.month.minutes)} of running, at ${rate}`;

  // Daily cost, last 14 days. One series: bar height is the cost, hover names the day.
  const top = Math.max(...c.days.map((d) => d.cost), 0.01);
  const tip = $("tip");
  const describe = (d: CostSummary["days"][number]) =>
    `${localDate(d.date).toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" })}: ` +
    (d.kwh > 0 ? `${approx}${euros(d.cost)}, ${kwh(d.kwh)}` : "not used");
  const todayKey = c.days.at(-1)!.date;
  const resting = `Today: ${describe(c.days.at(-1)!).split(": ")[1]}`;
  tip.hidden = false;
  tip.textContent = resting;
  $("chart-title").replaceChildren(el("span", "", "Cost per day, last 14 days"), el("span", "", top > 0.01 ? euros(top) : ""));
  $("chart").replaceChildren(
    ...c.days.map((d) => {
      const bar = el("div", d.date === todayKey ? "bar today" : "bar");
      bar.setAttribute("role", "listitem");
      bar.setAttribute("aria-label", describe(d));
      bar.tabIndex = 0;
      const ink = document.createElement("i");
      // Even a few cents gets a visible sliver, so a used day never looks unused.
      ink.style.height = d.cost > 0 ? `${Math.max(3, (d.cost / top) * 100)}%` : "0";
      bar.append(ink);
      const show = () => (tip.textContent = describe(d));
      const rest = () => (tip.textContent = resting);
      bar.addEventListener("pointerenter", show);
      bar.addEventListener("focus", show);
      bar.addEventListener("pointerleave", rest);
      bar.addEventListener("blur", rest);
      return bar;
    }),
  );
  let days = $("chart").nextElementSibling as HTMLElement;
  if (!days.classList.contains("days")) {
    days = el("div", "days");
    days.setAttribute("aria-hidden", "true");
    $("chart").after(days);
  }
  days.replaceChildren(...c.days.map((d) => el("span", "", WEEKDAYS[localDate(d.date).getDay()])));

  const s = c.settings;
  const save = (changes: Partial<Electricity>) => void ac.costSettings(changes).then(accept);
  segments($("set-meter"), ["single", "dual"], s.meter, (m) => [m === "single" ? "Single" : "Day / night"], (meter) => save({ meter }));
  const BLOCKS = {
    "1": ["Under 800", "Under 800 kWh every month"],
    "2": ["Over 800", "Over 800 kWh every month"],
    winter: ["Over 800 in winter", "Over 800 kWh from October to May, under it from June to September"],
  } as const;
  segments(
    $("set-block"),
    ["1", "2", "winter"] as const,
    String(s.block) as keyof typeof BLOCKS,
    (b) => [BLOCKS[b][0], BLOCKS[b][1]],
    (b) => save({ block: b === "winter" ? "winter" : b === "2" ? 2 : 1 }),
  );
  segments($("set-vat"), ["on", "off"], s.vat ? "on" : "off", (v) => [v === "on" ? "Added" : "Left out"], (v) => save({ vat: v === "on" }));

  $("set-watts-row").hidden = c.metered;
  const watts = $<HTMLInputElement>("set-watts");
  if (document.activeElement !== watts) watts.value = s.ratedWatts ? String(s.ratedWatts) : "";

  $("bill-how").textContent =
    (c.metered
      ? "Measured by the unit's own meter. "
      : c.needsRating
        ? "This unit does not meter itself, so the cost is estimated from running time. Enter the cooling input power in watts from its nameplate. "
        : "Estimated from running time, the rated power and how hard the unit is likely working. Expect it to be off by up to a third. ") +
    (!c.metered && c.assumedMinutes >= 1 ? `${hours(c.assumedMinutes)} this month were assumed while this Mac slept. ` : "") +
    "KESCO prices of October 2026, without the monthly fixed charge.";
}

// ── Temperature slider ──────────────────────────────────────────────────────

function range(): { min: number; max: number; step: number } {
  const caps = snap?.caps;
  return { min: caps?.minTemp ?? 16, max: caps?.maxTemp ?? 30, step: caps?.step ?? 1 };
}

function drawSlider(target: number): void {
  const { min, max } = range();
  const slider = $("slider");
  const ratio = Math.min(1, Math.max(0, (target - min) / (max - min)));
  const width = slider.clientWidth || 200;
  $("fill").style.width = `${FILL_MIN_PX + ratio * (width - FILL_MIN_PX)}px`;
  $("target").textContent = degrees(target);
  slider.setAttribute("aria-valuemin", String(min));
  slider.setAttribute("aria-valuemax", String(max));
  slider.setAttribute("aria-valuenow", String(target));
  slider.setAttribute("aria-valuetext", `${target} degrees`);
}

/** The temperature under a pointer position, snapped to what the unit accepts. */
function valueAt(clientX: number): number {
  const { min, max, step } = range();
  const box = $("slider").getBoundingClientRect();
  const ratio = (clientX - box.left - FILL_MIN_PX) / (box.width - FILL_MIN_PX);
  const raw = min + Math.min(1, Math.max(0, ratio)) * (max - min);
  return Math.round(raw / step) * step;
}

function nudge(steps: number): void {
  if (!shown?.power) return;
  const { min, max, step } = range();
  const next = Math.min(max, Math.max(min, shown.target + steps * step));
  if (next !== shown.target) change({ target: next }, TEMP_DEBOUNCE_MS);
}

// ── Drawing ─────────────────────────────────────────────────────────────────

function renderControls(s: AcState): void {
  const caps = snap!.caps!;

  // Sections the user chose to hide, from the right-click menu.
  const layout = snap!.layout;
  for (const [section, id] of [["unit", "sec-unit"], ["modes", "mode"], ["air", "sec-air"], ["extras", "sec-extras"], ["insight", "sec-insight"]] as const) {
    $(id).toggleAttribute("hidden", layout ? !layout[section] : false);
  }
  if (layout && !layout.extras) choosingTimer = false;
  document.body.classList.toggle("bare", layout ? !layout.unit : false);
  document.body.dataset.mode = s.mode;
  document.body.dataset.power = s.power ? "on" : "off";
  // The drawing of the unit reads these: air speed, swing and the display light.
  document.body.dataset.fan = s.fan;
  document.body.dataset.swing = s.swing;
  document.body.dataset.display = s.display || !caps.display ? "on" : "off";
  $("unit-digits").textContent = s.mode === "fan" ? "FA" : String(Math.round(s.target));

  $("power").setAttribute("aria-checked", String(s.power));
  $("doing").textContent = !s.power
    ? "Off"
    : s.selfClean
      ? "Self-cleaning"
      : s.mode === "fan"
        ? DOING.fan
        : `${DOING[s.mode]} ${degrees(s.target)}`;
  $("indoor").textContent = degrees(s.indoor);
  $("indoor").title = "Room temperature";
  $("outdoor").textContent = [
    s.humidity === null ? "" : `${Math.round(s.humidity)}% humid`,
    s.outdoor === null ? "" : `${degrees(s.outdoor)} outside`,
  ]
    .filter(Boolean)
    .join(", ");

  drawSlider(s.target);
  $<HTMLButtonElement>("down").disabled = s.target <= caps.minTemp;
  $<HTMLButtonElement>("up").disabled = s.target >= caps.maxTemp;

  replaceKeepingFocus(
    $("mode"),
    caps.modes.map((mode) => {
      const b = round(mode, MODE_LABEL[mode], () => mode !== s.mode && change({ mode }));
      b.setAttribute("role", "radio");
      b.setAttribute("aria-checked", String(mode === s.mode));
      return b;
    }),
  );

  segments($("fan"), caps.fans, s.fan, (f) => [FAN_LABEL[f]], (fan) => change({ fan }));
  segments($("swing"), caps.swings, s.swing, (w) => SWING_LABEL[w], (swing) => change({ swing }));

  const toggle = (iconName: string, caption: string, on: boolean, flip: () => void) => {
    const b = round(iconName, caption, flip);
    b.setAttribute("aria-pressed", String(on));
    return b;
  };
  const offAt = snap!.offAt;
  replaceKeepingFocus($("extras"), [
    ...(caps.eco ? [toggle("eco", "Eco", s.eco, () => change({ eco: !s.eco }))] : []),
    ...(caps.turbo ? [toggle("turbo", "Turbo", s.turbo, () => change({ turbo: !s.turbo }))] : []),
    toggle("sleep", "Sleep", s.sleep, () => change({ sleep: !s.sleep })),
    ...(caps.display ? [toggle("light", "Light", s.display, () => change({ display: !s.display }))] : []),
    toggle("timer", "Timer", offAt !== null, () => {
      choosingTimer = !choosingTimer;
      render(true);
    }),
  ]);

  const choices = $("timer-choices");
  choices.hidden = !choosingTimer;
  if (choosingTimer) {
    const pick = (minutes: number | null) => {
      choosingTimer = false;
      void ac.timer(minutes).then(accept);
    };
    const chip = (label: string, title: string, click: () => void) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.title = title;
      b.addEventListener("click", click);
      return b;
    };
    const cancel = chip("Cancel", "Cancel the off timer", () => pick(null));
    cancel.setAttribute("aria-pressed", "true");
    replaceKeepingFocus(choices, [
      ...TIMER_CHOICES.map(([minutes, label]) => chip(label, `Switch off in ${label}`, () => pick(minutes))),
      ...(offAt !== null ? [cancel] : []),
    ]);
  }

  // Footer: when it will switch off, and what it is drawing right now.
  const left = offAt !== null && s.power ? `Switches off in ${remaining(offAt)}` : "";
  const right =
    s.watts !== null && s.power
      ? `${Math.round(s.watts)} W now`
      : s.kwh !== null
        ? `${Math.round(s.kwh)} kWh used in total`
        : "";
  $("foot-left").textContent = left;
  $("foot-right").textContent = right;
  $("foot").classList.toggle("empty", !left && !right);

  renderSparkTile(snap!.spark);
  renderCostTile(snap!.cost);

  $("alerts").replaceChildren(
    ...(snap!.alerts ?? []).map((a) => {
      const box = el("div", a.severity === "problem" ? "alert is-problem" : "alert");
      box.append(el("b", "", a.title), document.createTextNode(a.body));
      return box;
    }),
  );
}

function renderNotice(): void {
  const status = snap?.status ?? "scanning";
  const name = snap?.device?.label ?? "the air conditioner";
  const primary = $<HTMLButtonElement>("primary");
  const secondary = $<HTMLButtonElement>("secondary");

  document.body.dataset.power = "off";
  $("notice-name").textContent = snap?.device?.label ?? "MideaBar";
  $("pulse").hidden = status !== "scanning";
  $("manual").hidden = status !== "no-device";
  $("signin").hidden = status !== "needs-account";
  $("notice").querySelector<HTMLElement>(".actions")!.hidden = status === "scanning" || status === "needs-account";
  $("notice-text").classList.toggle("error", status === "needs-account" && Boolean(snap?.message));
  secondary.hidden = status !== "offline";

  if (status === "scanning") {
    $("notice-title").textContent = "Looking for your air conditioner";
    $("notice-text").textContent =
      "This takes a few seconds. If macOS asks whether MideaBar may find devices on your local network, choose Allow.";
  } else if (status === "needs-account") {
    $("notice-title").textContent = "Found your air conditioner";
    $("notice-text").textContent =
      snap?.message ??
      "Midea only releases a unit's local key to the account that owns it. Sign in once with your SmartHome app account to finish pairing.";
  } else if (status === "no-device") {
    $("notice-title").textContent = "No air conditioner found";
    $("notice-text").textContent =
      snap?.message ?? "Make sure this Mac is on the same Wi-Fi as the unit, then look again.";
    primary.textContent = "Look again";
    primary.onclick = () => void scan();
  } else {
    $("notice-title").textContent = `Can't reach ${name}`;
    $("notice-text").textContent = snap?.message ?? "It may be unplugged or off Wi-Fi.";
    primary.textContent = "Try again";
    primary.onclick = () => void ac.refresh().then(accept);
    secondary.textContent = "Search the network";
    secondary.onclick = () => void scan();
  }
}

let drawn = "";

function render(force = false): void {
  // Background readings arrive every few seconds; redraw only when something changed.
  const next = JSON.stringify([snap, shown, choosingTimer, showingBill, showingTrend, trend, probe]);
  if (next === drawn && !force) return;
  drawn = next;

  const ready = snap?.status === "ready" && shown !== null && snap.caps !== null;
  // The bill only needs the usage log, so it stays up even if the unit drops off Wi-Fi.
  const bill = showingBill && snap?.cost !== undefined;
  const chart = showingTrend && trend !== null;
  const panel = bill || chart;
  $("bill").hidden = !bill;
  $("trend").hidden = !chart;
  $("controls").hidden = !ready || panel;
  $("notice").hidden = ready || panel;
  if (bill) {
    renderBill(snap!.cost!);
  } else if (chart) {
    renderTrend(trend!);
  } else if (ready) {
    $("name").textContent = snap!.device?.label ?? "Air conditioner";
    renderControls(shown!);
  } else {
    renderNotice();
  }
  fit();
}

/** Ask the main process to make the window exactly as tall as its content. */
function fit(): void {
  ac.resize(Math.ceil(document.body.getBoundingClientRect().height));
}

async function scan(ip?: string): Promise<void> {
  accept({ ...(snap ?? EMPTY), status: "scanning" });
  accept(await ac.scan(ip));
}

// ── Wiring ──────────────────────────────────────────────────────────────────

$("power").addEventListener("click", () => shown && change({ power: !shown.power }));
$("up").addEventListener("click", () => nudge(1));
$("down").addEventListener("click", () => nudge(-1));
for (const b of document.querySelectorAll("[data-menu]")) b.addEventListener("click", () => ac.menu());

$("cost").addEventListener("click", () => {
  showingBill = true;
  render();
});
$("bill-back").addEventListener("click", () => {
  showingBill = false;
  render();
});

async function loadTrend(): Promise<void> {
  trend = await ac.trend();
  render();
}
$("spark").addEventListener("click", () => {
  showingTrend = true;
  probe = null;
  void loadTrend();
});
$("trend-back").addEventListener("click", () => {
  showingTrend = false;
  render();
});
// Aim at a time, not at a line: the crosshair takes the reading nearest the pointer.
const plotEl = $("plot");
plotEl.addEventListener("pointermove", (e) => {
  if (!trend || trend.points.length === 0) return;
  const box = plotEl.getBoundingClientRect();
  const now = Date.now();
  const time = now - 24 * 3_600_000 + ((e.clientX - box.left - 24) / (box.width - 32)) * 24 * 3_600_000;
  let best = 0;
  trend.points.forEach((p, i) => {
    if (Math.abs(p.t - time) < Math.abs(trend!.points[best]!.t - time)) best = i;
  });
  if (best !== probe) {
    probe = best;
    render();
  }
});
plotEl.addEventListener("pointerleave", () => {
  probe = null;
  render();
});
plotEl.addEventListener("keydown", (e) => {
  if (!trend || (e.key !== "ArrowLeft" && e.key !== "ArrowRight")) return;
  e.preventDefault();
  e.stopPropagation();
  const last = trend.points.length - 1;
  probe = Math.min(last, Math.max(0, (probe ?? last) + (e.key === "ArrowLeft" ? -1 : 1)));
  render();
});
plotEl.addEventListener("blur", () => {
  probe = null;
  render();
});
const wattsInput = $<HTMLInputElement>("set-watts");
const saveWatts = () => {
  const watts = Number(wattsInput.value);
  const current = snap?.cost?.settings.ratedWatts ?? null;
  const next = wattsInput.value.trim() === "" ? null : watts;
  if (next !== current) void ac.costSettings({ ratedWatts: next }).then(accept);
};
wattsInput.addEventListener("change", saveWatts);
wattsInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") wattsInput.blur();
});

// Drag the slider: the number follows the pointer, and one command goes out on release.
const slider = $("slider");
slider.addEventListener("pointerdown", (e) => {
  if (!shown?.power || e.button !== 0) return;
  dragging = true;
  slider.classList.add("dragging");
  slider.setPointerCapture(e.pointerId);
  shown = { ...shown, target: valueAt(e.clientX) };
  render();
});
slider.addEventListener("pointermove", (e) => {
  if (!dragging || !shown) return;
  const target = valueAt(e.clientX);
  if (target === shown.target) return;
  shown = { ...shown, target };
  render();
});
const endDrag = () => {
  if (!dragging || !shown) return;
  dragging = false;
  slider.classList.remove("dragging");
  if (shown.target !== snap?.state?.target) change({ target: shown.target });
};
slider.addEventListener("pointerup", endDrag);
slider.addEventListener("pointercancel", endDrag);
slider.addEventListener("keydown", (e) => {
  const steps = ({ ArrowRight: 1, ArrowUp: 1, ArrowLeft: -1, ArrowDown: -1 } as Record<string, number>)[e.key];
  if (!steps) return;
  e.preventDefault();
  e.stopPropagation();
  nudge(steps);
});
// Two-finger scroll or a mouse wheel anywhere on the temperature tile.
let wheel = 0;
slider.parentElement!.addEventListener(
  "wheel",
  (e) => {
    e.preventDefault();
    wheel += e.deltaY || -e.deltaX;
    if (Math.abs(wheel) < 24) return;
    nudge(wheel < 0 ? 1 : -1);
    wheel = 0;
  },
  { passive: false },
);

$<HTMLFormElement>("signin").addEventListener("submit", (e) => {
  e.preventDefault();
  const account = $<HTMLInputElement>("account").value.trim();
  const field = $<HTMLInputElement>("password");
  const password = field.value;
  if (!account || !password) return;
  field.value = "";
  accept({ ...(snap ?? EMPTY), status: "scanning" });
  void ac.pair(account, password).then(accept);
});

$<HTMLFormElement>("manual").addEventListener("submit", (e) => {
  e.preventDefault();
  const ip = $<HTMLInputElement>("ip").value.trim();
  if (ip) void scan(ip);
});

// Rename: double-click the name, Enter to save, Esc to cancel.
const nameButton = $("name");
const renameInput = $<HTMLInputElement>("rename");
const endRename = (save: boolean) => {
  if (renameInput.hidden) return;
  renameInput.hidden = true;
  nameButton.hidden = false;
  if (save) void ac.rename(renameInput.value).then(accept);
};
nameButton.addEventListener("dblclick", () => {
  if (!snap?.device) return;
  renameInput.value = snap.device.label;
  nameButton.hidden = true;
  renameInput.hidden = false;
  renameInput.select();
});
renameInput.addEventListener("blur", () => endRename(true));
renameInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter") endRename(true);
  if (e.key === "Escape") {
    e.stopPropagation();
    endRename(false);
  }
});

window.addEventListener("keydown", (e) => {
  if (e.target instanceof HTMLInputElement) return;
  if (e.key === "Escape") {
    if (showingBill || showingTrend) {
      showingBill = false;
      showingTrend = false;
      render();
    } else if (choosingTimer) {
      choosingTimer = false;
      render(true);
    } else {
      ac.hide();
    }
  }
  if (showingBill || showingTrend) return;
  if (e.key === "ArrowUp") nudge(1);
  if (e.key === "ArrowDown") nudge(-1);
});

// The main process pushes a fresh reading every few seconds. Ignore it while a
// change of ours is still on its way, or the controls would flick back.
ac.onSnapshot((next) => {
  if (!busy()) accept(next);
  if (showingTrend && probe === null) void loadTrend();
});

// Keep "Switches off in …" current while the popover stays open.
window.setInterval(() => snap?.offAt && render(true), 30_000);

void ac.get().then(accept);
