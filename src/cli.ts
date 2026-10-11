import { createInterface } from "node:readline";
import { AcController } from "./core/controller";
import { defaultConfigPath, Store } from "./core/store";
import { UsageLog } from "./core/usage";
import { dirname, join } from "node:path";
import type { Fan, Mode, Patch, Snapshot, Swing } from "./core/types";

const HELP = `midea — control a Midea air conditioner over the local network

  midea scan [ip]        find units on this network and pair with them
       --account=<email> SmartHome sign-in of the unit's owner; needed once per
                         unit. The password is asked for and not saved.
  midea status           show what the unit is doing
  midea on | off
  midea set key=value …  temp=23  mode=auto|cool|dry|heat|fan
                         fan=auto|silent|low|medium|high|max
                         swing=off|vertical|horizontal|both
                         eco=on|off  turbo=on|off  sleep=on|off  power=on|off
                         light=on|off (the unit's display)
  midea cost             what the unit has cost to run today and this month
                         (measured by the menu bar app while it runs)
  midea list             units this Mac knows about
  midea use <number>     switch to another unit from the list
  midea name <text>      rename the current unit

  --json                 print the raw snapshot
  --verbose              show protocol logging

Shares its settings with the MideaBar menu bar app.`;

const args = process.argv.slice(2);
const flags = new Set(args.filter((a) => a.startsWith("--")));
const [command, ...rest] = args.filter((a) => !a.startsWith("--"));
const account = args.find((a) => a.startsWith("--account="))?.slice("--account=".length);

if (!flags.has("--verbose")) {
  // The protocol library logs every packet; keep the terminal readable.
  console.debug = () => {};
  console.warn = () => {};
  console.error = () => {};
}

const out = (line: string): void => void process.stdout.write(`${line}\n`);
const die = (line: string): never => {
  process.stderr.write(`${line}\n`);
  process.exit(1);
};

const onOff = (key: string, v: string): boolean => {
  if (["on", "true", "1", "yes"].includes(v)) return true;
  if (["off", "false", "0", "no"].includes(v)) return false;
  return die(`${key} must be on or off, got "${v}".`);
};

const oneOf = <T extends string>(key: string, v: string, allowed: readonly T[]): T =>
  allowed.includes(v as T) ? (v as T) : die(`${key} must be one of ${allowed.join(", ")}; got "${v}".`);

function parsePatch(pairs: string[]): Patch {
  const patch: Patch = {};
  for (const pair of pairs) {
    const [key, value = ""] = pair.toLowerCase().split("=");
    switch (key) {
      case "temp":
      case "target": {
        const t = Number(value);
        if (!Number.isFinite(t)) die(`temp must be a number in °C, got "${value}".`);
        patch.target = t;
        break;
      }
      case "mode":
        patch.mode = oneOf<Mode>("mode", value, ["auto", "cool", "dry", "heat", "fan"]);
        break;
      case "fan":
        patch.fan = oneOf<Fan>("fan", value, ["auto", "silent", "low", "medium", "high", "max"]);
        break;
      case "swing":
        patch.swing = oneOf<Swing>("swing", value, ["off", "vertical", "horizontal", "both"]);
        break;
      case "light":
        patch.display = onOff(key, value);
        break;
      case "power":
      case "eco":
      case "turbo":
      case "sleep":
        patch[key] = onOff(key, value);
        break;
      default:
        die(`Unknown setting "${key}". Run "midea help" for the list.`);
    }
  }
  return patch;
}

/** Read a line from the terminal without echoing it. */
function askHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    const raw = rl as unknown as { _writeToOutput: (text: string) => void };
    process.stdout.write(question);
    raw._writeToOutput = () => {};
    rl.question("", (answer) => {
      rl.close();
      process.stdout.write("\n");
      resolve(answer);
    });
  });
}

function print(snap: Snapshot): void {
  if (flags.has("--json")) return out(JSON.stringify(snap, null, 2));

  if (snap.status === "needs-account") {
    if (snap.message) out(snap.message);
    return out(
      "Found a unit. Midea only releases its local key to the SmartHome account that owns it.\n" +
        "Run: midea scan --account=you@example.com",
    );
  }

  if (snap.status === "no-device") {
    return out(snap.message ?? 'No air conditioner set up yet. Run "midea scan".');
  }
  const name = `${snap.device?.label} (${snap.device?.ip})`;
  if (snap.status !== "ready" || !snap.state) {
    return out(`${name}: unreachable. ${snap.message ?? ""}`.trim());
  }

  const s = snap.state;
  const deg = (t: number | null) => (t === null ? "–" : `${t}°`);
  const extras = [s.eco && "eco", s.turbo && "turbo", s.sleep && "sleep"].filter(Boolean).join(", ");
  out(name);
  out(`  ${s.power ? "On" : "Off"}, ${s.mode}, set to ${deg(s.target)}`);
  out(`  Room ${deg(s.indoor)}, outside ${deg(s.outdoor)}`);
  out(`  Fan ${s.fan}, swing ${s.swing}${extras ? `, ${extras}` : ""}`);
  if (s.watts !== null && s.power) out(`  Drawing ${Math.round(s.watts)} W`);
  if (snap.offAt !== null) out(`  Switches off at ${new Date(snap.offAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })} (needs MideaBar running)`);
  if (s.errorCode) out(`  The unit reports fault code ${s.errorCode}.`);
}

async function main(): Promise<void> {
  const store = new Store();
  const ac = new AcController(store);

  switch (command) {
    case undefined:
    case "help":
      return out(HELP);

    case "scan":
    case "add": {
      out(rest[0] ? `Asking ${rest[0]}…` : "Looking for air conditioners on this network…");
      const password = account ? (process.env.MIDEA_PASSWORD ?? (await askHidden("SmartHome password: "))) : "";
      const snap = await ac.scan(rest[0], account ? { account, password } : undefined);
      if (snap.status === "ready") out(`Paired with ${snap.devices.length} unit(s).`);
      return print(snap);
    }

    case "status":
      return print(await ac.refresh(true));

    case "on":
    case "off":
      return print(await ac.set({ power: command === "on" }));

    case "set":
      if (rest.length === 0) die('Nothing to set. Example: midea set temp=23 mode=cool');
      return print(await ac.set(parsePatch(rest)));

    case "cost": {
      const sum = new UsageLog(join(dirname(defaultConfigPath()), "usage.json")).summary(store.electricity);
      if (flags.has("--json")) return out(JSON.stringify(sum, null, 2));
      if (sum.needsRating) {
        return out("This unit does not meter itself. Enter its rated power in MideaBar's Electricity panel to get an estimate.");
      }
      const line = (name: string, f: { kwh: number; cost: number; minutes: number }) =>
        out(`  ${name.padEnd(11)} ${sum.metered ? "" : "≈ "}€${f.cost.toFixed(2)}   ${f.kwh.toFixed(1)} kWh   ${(f.minutes / 60).toFixed(1)} h running`);
      out(sum.metered ? "Measured by the unit:" : "Estimated from running time:");
      line("Today", sum.today);
      line("This month", sum.month);
      const c = sum.cents;
      return out(
        `  at ${c.high === c.low ? `${c.high.toFixed(2)} c/kWh` : `${c.high.toFixed(2)} c/kWh by day, ${c.low.toFixed(2)} c at night`}` +
          `${sum.settings.vat ? ", VAT included" : ", before VAT"}`,
      );
    }

    case "list":
      if (store.devices.length === 0) return out('No units yet. Run "midea scan".');
      ac.snapshot().devices.forEach((d, i) =>
        out(`${store.selected?.id === d.id ? "*" : " "} ${i + 1}  ${d.label}  ${store.devices[i]?.ip}`),
      );
      return;

    case "use": {
      const picked = store.devices[Number(rest[0]) - 1];
      if (!picked) return die('No unit with that number. Run "midea list".');
      return print(await ac.select(picked.id));
    }

    case "name": {
      const current = store.selected;
      if (!current) return die('No unit yet. Run "midea scan".');
      store.rename(current.id, rest.join(" "));
      return out(`Renamed to ${ac.snapshot().device?.label}.`);
    }

    default:
      die(`Unknown command "${command}". Run "midea help".`);
  }
}

main().then(
  () => process.exit(0),
  (e) => die(e instanceof Error ? e.message : String(e)),
);
