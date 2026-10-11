import {
  AirConditioner,
  AuthenticationError,
  Discover,
  ENERGY_DATA_FORMAT,
  FAN_SPEED,
  OPERATIONAL_MODE,
  SWING_MODE,
  type Device,
} from "midea-local";
import { lanKeys, NeedsAccountError, type Credentials } from "./cloud";
import type { Store } from "./store";
import { sweep } from "./sweep";
import type { AcCaps, AcState, DeviceRecord, Fan, Mode, Patch, Snapshot, Swing } from "./types";

// ── Protocol values ↔ names ─────────────────────────────────────────────────

const MODE_TO_WIRE: Record<Mode, number> = {
  auto: OPERATIONAL_MODE.AUTO,
  cool: OPERATIONAL_MODE.COOL,
  dry: OPERATIONAL_MODE.DRY,
  heat: OPERATIONAL_MODE.HEAT,
  fan: OPERATIONAL_MODE.FAN_ONLY,
};

const FAN_TO_WIRE: Record<Fan, number> = {
  auto: FAN_SPEED.AUTO,
  silent: FAN_SPEED.SILENT,
  low: FAN_SPEED.LOW,
  medium: FAN_SPEED.MEDIUM,
  high: FAN_SPEED.HIGH,
  max: FAN_SPEED.MAX,
};

const SWING_TO_WIRE: Record<Swing, number> = {
  off: SWING_MODE.OFF,
  vertical: SWING_MODE.VERTICAL,
  horizontal: SWING_MODE.HORIZONTAL,
  both: SWING_MODE.BOTH,
};

export function modeFromWire(v: number): Mode {
  if (v === OPERATIONAL_MODE.SMART_DRY) return "dry";
  return (Object.keys(MODE_TO_WIRE) as Mode[]).find((k) => MODE_TO_WIRE[k] === v) ?? "auto";
}

/** Units report fan speed as a percentage; anything above 100 means automatic. */
export function fanFromWire(v: number): Fan {
  if (v > 100) return "auto";
  if (v <= 20) return "silent";
  if (v <= 40) return "low";
  if (v <= 60) return "medium";
  if (v <= 80) return "high";
  return "max";
}

export function swingFromWire(v: number): Swing {
  return (Object.keys(SWING_TO_WIRE) as Swing[]).find((k) => SWING_TO_WIRE[k] === v) ?? "off";
}

const MODES: Mode[] = ["auto", "cool", "dry", "heat", "fan"];
const FANS: Fan[] = ["auto", "silent", "low", "medium", "high", "max"];
const SWINGS: Swing[] = ["off", "vertical", "horizontal", "both"];

/** How long to wait before searching the network again for a unit that stopped answering. */
const RELOCATE_EVERY_MS = 2 * 60_000;

/**
 * Reconnect after this long. Some units stop answering on a connection that
 * has been open for many minutes; a fresh one costs about a second.
 */
const CONNECTION_LIFETIME_S = 120;

/** Re-read the unit before a change if our copy of its state is older than this. */
const STALE_AFTER_MS = 5_000;

/**
 * Owns the connection to the selected air conditioner.
 *
 * All network work runs through one queue, because the device accepts a single
 * request at a time on its TCP connection.
 */
export class AcController {
  private ac: AirConditioner | null = null;
  private scanning = false;
  /** Set when a unit was found but Midea wants its owner to sign in before releasing the key. */
  private needsAccount: { ip: string } | null = null;
  /** Units that advertise energy figures but do not answer when asked. */
  private energyBroken = new Set<number>();
  private message: string | undefined;
  private lastRelocate = 0;
  private lastRefresh = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly store: Store) {}

  // ── Public API ────────────────────────────────────────────────────────────

  /** Current view of the world, without touching the network. */
  snapshot(): Snapshot {
    const rec = this.store.selected;
    const many = this.store.devices.length > 1;
    const label = (d: DeviceRecord) => d.label ?? (many ? `AC ${d.name.slice(-4)}` : "Air conditioner");
    const live = this.ac !== null && rec !== null && this.ac.id === rec.id && this.ac.online;

    return {
      status: this.scanning
        ? "scanning"
        : live
          ? "ready"
          : this.needsAccount
            ? "needs-account"
            : rec
              ? "offline"
              : "no-device",
      message: this.message,
      device: rec ? { id: rec.id, label: label(rec), ip: rec.ip } : null,
      devices: this.store.devices.map((d) => ({ id: d.id, label: label(d) })),
      state: live ? this.readState(this.ac!) : null,
      caps: live ? this.readCaps(this.ac!) : null,
      offAt: this.store.offAt,
    };
  }

  /** Read the unit's current state. `force` searches the network again if it is unreachable. */
  refresh(force = false): Promise<Snapshot> {
    return this.enqueue(() =>
      this.attempt(force, async (ac) => {
        await this.read(ac);
      }),
    );
  }

  /** Change one or more settings and return the state the unit reports back. */
  set(patch: Patch): Promise<Snapshot> {
    return this.enqueue(() =>
      this.attempt(true, async (ac) => {
        // Someone may have used the remote since we last looked. The protocol
        // sends the full state on every change, so a stale copy would undo theirs.
        if (Date.now() - this.lastRefresh > STALE_AFTER_MS) await this.read(ac);

        const { display, ...settings } = patch;

        if (Object.keys(settings).length > 0) {
          ac.beep = this.store.beep;
          if (settings.power !== undefined) ac.powerState = settings.power;
          if (settings.mode !== undefined) ac.operationalMode = MODE_TO_WIRE[settings.mode] as never;
          if (settings.fan !== undefined) ac.fanSpeed = FAN_TO_WIRE[settings.fan];
          if (settings.swing !== undefined) ac.swingMode = SWING_TO_WIRE[settings.swing] as never;
          if (settings.sleep !== undefined) ac.sleep = settings.sleep;
          // Eco and turbo are opposites; the unit ignores a request for both.
          if (settings.eco !== undefined) {
            ac.eco = settings.eco;
            if (settings.eco) ac.turbo = false;
          }
          if (settings.turbo !== undefined) {
            ac.turbo = settings.turbo;
            if (settings.turbo) ac.eco = false;
          }

          let asked: number | undefined;
          if (settings.target !== undefined) {
            const step = this.step(ac);
            const t = Math.round(settings.target / step) * step;
            asked = Math.min(ac.maxTargetTemperature, Math.max(ac.minTargetTemperature, t));
            ac.targetTemperature = asked;
          }

          await ac.apply();
          if (!ac.online) throw new Error("no answer");

          // A unit that ignores half degrees answers with the whole number.
          // Learn that once, so the controls stop offering steps it will not take.
          const got = ac.targetTemperature;
          if (asked !== undefined && !Number.isInteger(asked) && got !== null && got !== asked && Number.isInteger(got)) {
            this.store.learn(ac.id, { wholeDegrees: true });
          }

          // Switching off by hand makes a pending off timer pointless.
          if (settings.power === false) this.store.setOffTimer(null);
        }

        // The display light is a toggle on the wire, so only send it when it would change something.
        if (display !== undefined && ac.supportsDisplayControl && (ac.displayOn ?? true) !== display) {
          ac.beep = this.store.beep;
          await ac.toggleDisplay();
          if (!ac.online) throw new Error("no answer");
        }

        this.lastRefresh = Date.now();
        this.message = undefined;
      }),
    );
  }

  /** Start the unit's self-clean cycle. It runs for a while and stops by itself. */
  selfClean(): Promise<Snapshot> {
    return this.enqueue(() =>
      this.attempt(true, async (ac) => {
        if (!ac.supportsSelfClean) return;
        ac.beep = this.store.beep;
        await ac.startSelfClean();
        await this.read(ac);
      }),
    );
  }

  /** Switch the current unit off after `minutes`. Pass null to cancel. */
  setOffTimer(minutes: number | null): Snapshot {
    const valid = minutes !== null && Number.isFinite(minutes) && minutes > 0 && minutes <= 24 * 60;
    this.store.setOffTimer(valid ? Date.now() + Math.round(minutes) * 60_000 : null);
    return this.snapshot();
  }

  /**
   * Look for air conditioners on the network and pair with them. Pass an IP to
   * skip the search. `credentials` are only needed the first time a unit is
   * paired, and are dropped when this call returns.
   */
  scan(ip?: string, credentials?: Credentials): Promise<Snapshot> {
    this.scanning = true;
    return this.enqueue(async () => {
      try {
        this.needsAccount = null;
        const found = await this.discover(ip);
        let adopted = 0;
        let lastError: unknown;

        for (const device of found) {
          try {
            const known = this.store.devices.find((d) => d.id === device.id);
            await this.adopt(device, known, credentials);
            adopted++;
          } catch (e) {
            lastError = e;
          }
        }

        if (adopted > 0) {
          this.message = undefined;
        } else if (this.needsAccount) {
          // Before anyone has signed in there is nothing to report; afterwards, say why it failed.
          this.message = credentials ? reason(lastError) : undefined;
        } else if (found.length > 0) {
          this.message = `Found an air conditioner but could not pair with it. ${reason(lastError)}`;
        } else {
          this.message = ip
            ? `Nothing answered at ${ip}. Check the address in your router or in the SmartHome app.`
            : "No air conditioner answered. Make sure this Mac is on the same Wi-Fi as the unit.";
        }
      } catch (e) {
        this.message = reason(e);
      } finally {
        this.scanning = false;
      }
      return this.snapshot();
    });
  }

  /** Finish pairing the unit that is waiting for its owner's SmartHome sign-in. */
  pair(credentials: Credentials): Promise<Snapshot> {
    return this.scan(this.needsAccount?.ip, credentials);
  }

  /** Switch to another known unit. */
  select(id: number): Promise<Snapshot> {
    return this.enqueue(async () => {
      this.store.select(id);
      this.ac = null;
      this.message = undefined;
      return this.snapshot();
    }).then(() => this.refresh(true));
  }

  // ── Internals ─────────────────────────────────────────────────────────────

  private enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.queue.then(job, job);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /**
   * Run `work` against the selected unit. If it fails on a connection we were
   * already holding, the connection may simply have gone stale (the unit drops
   * idle sockets), so reconnect and try once more before reporting it offline.
   */
  private async attempt(force: boolean, work: (ac: AirConditioner) => Promise<void>): Promise<Snapshot> {
    for (const lastTry of [false, true]) {
      const reused = this.ac !== null;
      try {
        const ac = await this.connected(force);
        if (ac) await work(ac);
        break;
      } catch (e) {
        this.ac = null;
        if (reused && !lastTry) continue;
        const rec = this.store.selected;
        this.message = rec ? `No answer from ${rec.ip}. The unit may be unplugged or off Wi-Fi.` : undefined;
        if (process.env.MIDEABAR_DEBUG) console.error(e);
        break;
      }
    }
    return this.snapshot();
  }

  private async read(ac: AirConditioner): Promise<void> {
    await this.poll(ac);
    this.message = undefined;
  }

  /** Return a live connection to the selected unit, or null when none is set up. */
  private async connected(mayRelocate: boolean): Promise<AirConditioner | null> {
    const rec = this.store.selected;
    if (!rec) return null;
    if (this.ac && this.ac.id === rec.id) return this.ac;

    try {
      this.ac = await this.open(rec);
      this.needsAccount = null;
      return this.ac;
    } catch (firstError) {
      // The router may have handed the unit a new address. Search for it by ID,
      // but not on every poll while it is simply switched off at the wall.
      const due = Date.now() - this.lastRelocate > RELOCATE_EVERY_MS;
      if (!mayRelocate && !due) throw firstError;
      this.lastRelocate = Date.now();

      const match = (await this.discover()).find((d) => d.id === rec.id);
      if (!match) throw firstError;
      await this.adopt(match, rec);
      return this.ac;
    }
  }

  /** Connect to a unit we already hold credentials for. */
  private async open(rec: DeviceRecord): Promise<AirConditioner> {
    const ac = new AirConditioner({
      ip: rec.ip,
      port: rec.port,
      deviceId: rec.id,
      sn: rec.sn,
      name: rec.name,
      version: rec.version,
    });
    ac.setMaxConnectionLifetime(CONNECTION_LIFETIME_S);
    if (rec.version === 3) {
      if (!rec.token || !rec.key) throw new AuthenticationError("missing token");
      await ac.authenticate(rec.token, rec.key);
    }
    await ac.getCapabilities();
    if (this.energyBroken.has(ac.id)) ac.enableEnergyUsageRequests = false;
    else await this.probeEnergy(ac);
    await this.poll(ac);
    return ac;
  }

  /** Pair with a discovered unit, save it, and make it current if it is the selected one. */
  private async adopt(device: AirConditioner, known?: DeviceRecord, credentials?: Credentials): Promise<void> {
    if (device.version === 3) {
      let authenticated = false;
      if (known?.token && known.key) {
        try {
          await device.authenticate(known.token, known.key);
          authenticated = true;
        } catch (e) {
          if (!(e instanceof AuthenticationError)) throw e;
        }
      }
      if (!authenticated) await this.fetchKey(device, credentials);
    }

    device.setMaxConnectionLifetime(CONNECTION_LIFETIME_S);
    await device.getCapabilities();
    if (this.energyBroken.has(device.id)) device.enableEnergyUsageRequests = false;
    await this.poll(device);

    this.store.upsert({
      id: device.id,
      ip: device.ip,
      port: device.port,
      name: device.name ?? "",
      sn: device.sn ?? "",
      version: device.version ?? 2,
      ...(device.token && device.key ? { token: device.token, key: device.key } : {}),
    });

    this.needsAccount = null;
    if (this.store.selected?.id === device.id) {
      this.ac = device;
      this.lastRefresh = Date.now();
    }
  }

  /**
   * Fetch the unit's token and key from Midea's cloud and unlock the unit with
   * them. This is the only step that needs the internet, and it happens once
   * per unit: the result is saved, the sign-in is not.
   */
  private async fetchKey(device: AirConditioner, credentials?: Credentials): Promise<void> {
    this.needsAccount = { ip: device.ip };
    if (!credentials) throw new NeedsAccountError();

    let offered = 0;
    for await (const { token, key } of lanKeys(device.id, credentials)) {
      offered++;
      try {
        await device.authenticate(token, key);
        return;
      } catch (e) {
        if (!(e instanceof AuthenticationError)) throw e;
      }
    }
    throw new Error(
      offered > 0
        ? "Midea issued a key but the unit rejected it. Try once more; if it keeps failing, this unit's Wi-Fi module may not allow local control."
        : "Midea's cloud did not return a key for this unit.",
    );
  }

  private async discover(ip?: string): Promise<AirConditioner[]> {
    let devices: (Device | null)[] = [];

    if (ip) {
      devices = [await Discover.discoverSingle(ip, { autoConnect: false, timeout: 3 })];
    } else {
      try {
        devices = await Discover.discover({ autoConnect: false, timeout: 3 });
      } catch {
        // Broadcast was refused (no route, or macOS has not granted Local Network yet).
      }
      if (devices.length === 0) {
        const ips = await sweep();
        devices = await Promise.all(
          ips.map((host) =>
            Discover.discoverSingle(host, { autoConnect: false, timeout: 2 }).catch(() => null),
          ),
        );
      }
    }

    return devices.filter((d): d is AirConditioner => d instanceof AirConditioner);
  }

  /** The library switches energy requests on when the unit's capability report offers them. */
  private hasEnergy(ac: AirConditioner): boolean {
    return ac.enableEnergyUsageRequests && !this.energyBroken.has(ac.id);
  }

  /**
   * Read the unit's state. Energy figures are an extra request; if a unit that
   * advertises them never answers it, stop asking rather than call the unit offline.
   */
  private async poll(ac: AirConditioner): Promise<void> {
    try {
      await ac.refresh();
    } catch (e) {
      if (!ac.enableEnergyUsageRequests) throw e;
      this.energyBroken.add(ac.id);
      this.store.learn(ac.id, { meters: false });
      ac.enableEnergyUsageRequests = false;
      await ac.refresh();
    }
    if (!ac.online) throw new Error("no answer");
    this.lastRefresh = Date.now();
  }

  /**
   * Some units report energy use without listing it among their capabilities.
   * Ask each unit once and remember the answer, so a unit that does meter
   * itself gets real cost figures instead of estimates.
   */
  private async probeEnergy(ac: AirConditioner): Promise<void> {
    const known = this.store.devices.find((d) => d.id === ac.id)?.meters;
    if (ac.enableEnergyUsageRequests || known === false) return;
    ac.enableEnergyUsageRequests = true;
    if (known === true) return;

    await this.poll(ac);
    const answered = ac.enableEnergyUsageRequests && ac.getTotalEnergyUsage(this.energyFormat()) !== null;
    if (!answered) ac.enableEnergyUsageRequests = false;
    this.store.learn(ac.id, { meters: answered });
  }

  private step(ac: AirConditioner): 0.5 | 1 {
    return this.store.devices.find((d) => d.id === ac.id)?.wholeDegrees ? 1 : 0.5;
  }

  private energyFormat() {
    return this.store.energyBinary ? ENERGY_DATA_FORMAT.BINARY : ENERGY_DATA_FORMAT.BCD;
  }

  private readState(ac: AirConditioner): AcState {
    return {
      power: ac.powerState ?? false,
      mode: modeFromWire(ac.operationalMode),
      target: ac.targetTemperature ?? 24,
      indoor: ac.indoorTemperature,
      outdoor: ac.outdoorTemperature,
      fan: fanFromWire(ac.fanSpeed),
      swing: swingFromWire(ac.swingMode),
      eco: ac.eco ?? false,
      turbo: ac.turbo ?? false,
      sleep: ac.sleep ?? false,
      display: ac.displayOn ?? true,
      selfClean: ac.selfCleanActive ?? false,
      filter: ac.filterAlert ?? false,
      humidity: ac.supportsHumidity ? ac.indoorHumidity : null,
      watts: ac.getRealTimePowerUsage(this.energyFormat()),
      kwh: ac.getTotalEnergyUsage(this.energyFormat()),
      errorCode: ac.errorCode ?? 0,
    };
  }

  private readCaps(ac: AirConditioner): AcCaps {
    const state = this.readState(ac);
    // Keep a fixed display order, and always offer whatever the unit is doing
    // right now even if its capability report left it out.
    const pick = <T extends string>(order: T[], reported: T[], current: T, fallback: T[]): T[] => {
      const base = reported.length >= 2 ? reported : fallback;
      return order.filter((x) => base.includes(x) || x === current);
    };
    return {
      minTemp: ac.minTargetTemperature,
      maxTemp: ac.maxTargetTemperature,
      modes: pick(MODES, ac.supportedOperationModes.map(modeFromWire), state.mode, MODES),
      fans: pick(FANS, ac.supportedFanSpeeds.map(fanFromWire), state.fan, ["auto", "low", "medium", "high"]),
      swings: pick(SWINGS, ac.supportedSwingModes.map(swingFromWire), state.swing, ["off", "vertical"]),
      eco: ac.supportsEco,
      turbo: ac.supportsTurbo,
      step: this.step(ac),
      display: ac.supportsDisplayControl,
      selfClean: ac.supportsSelfClean,
      energy: this.hasEnergy(ac),
    };
  }
}

function reason(e: unknown): string {
  return e instanceof Error ? e.message : String(e ?? "");
}
