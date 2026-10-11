import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Config, DeviceRecord, Electricity } from "./types";

/**
 * Defaults follow the owner's own KESCO contract: a single-tariff meter in a
 * household that usually passes 800 kWh a month. Both are settings in the app.
 */
const ELECTRICITY: Electricity = { meter: "single", block: 2, vat: true, ratedWatts: null };

const EMPTY: Config = {
  devices: [],
  selectedId: null,
  beep: true,
  energyBinary: false,
  offAt: null,
  offId: null,
  electricity: ELECTRICITY,
  notify: true,
  alerted: {},
};

function readElectricity(raw: unknown): Electricity {
  const r = (raw ?? {}) as Partial<Electricity>;
  const watts = Number(r.ratedWatts);
  return {
    meter: r.meter === "dual" ? "dual" : r.meter === "single" ? "single" : ELECTRICITY.meter,
    block: r.block === 1 ? 1 : r.block === 2 ? 2 : ELECTRICITY.block,
    vat: typeof r.vat === "boolean" ? r.vat : ELECTRICITY.vat,
    // Anything outside what a household unit can draw is a typo.
    ratedWatts: Number.isFinite(watts) && watts >= 100 && watts <= 10_000 ? Math.round(watts) : null,
  };
}

/**
 * Where the config lives. On macOS this is the same folder Electron uses for
 * an app named "MideaBar", so the menu bar app and the CLI share one file.
 */
export function defaultConfigPath(): string {
  if (process.env.MIDEABAR_CONFIG) return process.env.MIDEABAR_CONFIG;
  const base =
    process.platform === "darwin"
      ? join(homedir(), "Library", "Application Support")
      : process.env.XDG_CONFIG_HOME || join(homedir(), ".config");
  return join(base, "MideaBar", "config.json");
}

/** Small JSON file holding known devices and their LAN credentials. */
export class Store {
  private config: Config;

  constructor(readonly path: string = defaultConfigPath()) {
    this.config = this.read();
  }

  private read(): Config {
    try {
      const raw = JSON.parse(readFileSync(this.path, "utf8")) as Partial<Config>;
      return {
        devices: Array.isArray(raw.devices) ? raw.devices : [],
        selectedId: typeof raw.selectedId === "number" ? raw.selectedId : null,
        beep: typeof raw.beep === "boolean" ? raw.beep : EMPTY.beep,
        energyBinary: raw.energyBinary === true,
        offAt: typeof raw.offAt === "number" ? raw.offAt : null,
        offId: typeof raw.offId === "number" ? raw.offId : null,
        electricity: readElectricity(raw.electricity),
        notify: typeof raw.notify === "boolean" ? raw.notify : EMPTY.notify,
        alerted: raw.alerted && typeof raw.alerted === "object" ? { ...raw.alerted } : {},
      };
    } catch {
      return structuredClone(EMPTY);
    }
  }

  private write(): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.tmp`;
    // 0600: the file holds the token and key that unlock local control.
    writeFileSync(tmp, JSON.stringify(this.config, null, 2), { mode: 0o600 });
    renameSync(tmp, this.path);
  }

  get devices(): DeviceRecord[] {
    return this.config.devices;
  }

  get selected(): DeviceRecord | null {
    const { devices, selectedId } = this.config;
    return devices.find((d) => d.id === selectedId) ?? devices[0] ?? null;
  }

  get beep(): boolean {
    return this.config.beep;
  }

  set beep(on: boolean) {
    this.config.beep = on;
    this.write();
  }

  get energyBinary(): boolean {
    return this.config.energyBinary;
  }

  set energyBinary(on: boolean) {
    this.config.energyBinary = on;
    this.write();
  }

  get notify(): boolean {
    return this.config.notify;
  }

  set notify(on: boolean) {
    this.config.notify = on;
    this.write();
  }

  /** Live object: the alert checker updates it in place, then calls saveAlerted(). */
  get alerted(): Record<string, number> {
    return this.config.alerted;
  }

  saveAlerted(): void {
    this.write();
  }

  get electricity(): Electricity {
    return this.config.electricity;
  }

  /** Change some of the cost settings; invalid values fall back to what was there. */
  setElectricity(changes: Partial<Electricity>): void {
    this.config.electricity = readElectricity({ ...this.config.electricity, ...changes });
    this.write();
  }

  /** The pending off timer, if it belongs to the selected unit. */
  get offAt(): number | null {
    return this.config.offAt !== null && this.config.offId === this.selected?.id ? this.config.offAt : null;
  }

  setOffTimer(at: number | null): void {
    const id = this.selected?.id ?? null;
    if (this.config.offAt === at && (at === null || this.config.offId === id)) return;
    this.config.offAt = at;
    this.config.offId = at === null ? null : id;
    this.write();
  }

  /** Remember something learned about a unit. */
  learn(id: number, facts: Partial<Pick<DeviceRecord, "wholeDegrees" | "meters">>): void {
    const d = this.config.devices.find((x) => x.id === id);
    if (!d) return;
    Object.assign(d, facts);
    this.write();
  }

  select(id: number): void {
    if (!this.config.devices.some((d) => d.id === id)) return;
    this.config.selectedId = id;
    this.write();
  }

  /** Insert or update a device, keeping any label the user already set. */
  upsert(record: DeviceRecord): void {
    const i = this.config.devices.findIndex((d) => d.id === record.id);
    if (i >= 0) {
      const old = this.config.devices[i]!;
      this.config.devices[i] = { ...old, ...record, label: record.label ?? old.label };
    } else {
      this.config.devices.push(record);
    }
    if (this.config.selectedId === null) this.config.selectedId = record.id;
    this.write();
  }

  rename(id: number, label: string): void {
    const d = this.config.devices.find((x) => x.id === id);
    if (!d) return;
    d.label = label.trim() || undefined;
    this.write();
  }
}
