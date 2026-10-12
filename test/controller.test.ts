import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { AcController, fanFromWire, modeFromWire, swingFromWire } from "../src/core/controller";
import { Store } from "../src/core/store";
import { startFakeAc, type FakeAc } from "../scripts/fake-ac";

console.debug = () => {};
console.warn = () => {};

let fake: FakeAc;
let store: Store;
let ac: AcController;

before(async () => {
  fake = await startFakeAc(0);
  store = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
  store.upsert({ id: fake.id, ip: "127.0.0.1", port: fake.port, name: "net_ac_5678", sn: "TEST", version: 2 });
  ac = new AcController(store);
});

after(() => fake.close());

test("wire values map to names", () => {
  assert.equal(modeFromWire(2), "cool");
  assert.equal(modeFromWire(6), "dry");
  assert.equal(fanFromWire(102), "auto");
  assert.equal(fanFromWire(60), "medium");
  assert.equal(fanFromWire(35), "low");
  assert.equal(swingFromWire(12), "vertical");
  assert.equal(swingFromWire(15), "both");
});

test("reads state from the unit", async () => {
  const snap = await ac.refresh();
  assert.equal(snap.status, "ready");
  assert.deepEqual(snap.device, { id: fake.id, label: "Air conditioner", ip: "127.0.0.1" });
  assert.equal(snap.state?.power, false);
  assert.equal(snap.state?.mode, "cool");
  assert.equal(snap.state?.target, 24);
  assert.equal(snap.state?.indoor, 26.4);
  assert.equal(snap.state?.outdoor, 31);
  assert.equal(snap.state?.fan, "auto");
  assert.deepEqual(snap.caps, {
    minTemp: 16, maxTemp: 30,
    modes: ["auto", "cool", "dry", "heat", "fan"],
    fans: ["auto", "low", "medium", "high"],
    swings: ["off", "vertical", "horizontal", "both"],
    eco: true, turbo: true,
    step: 0.5, display: true, selfClean: true, energy: true,
  });
  assert.equal(snap.state?.watts, 432.1);
  assert.equal(snap.state?.kwh, 1234.56);
  assert.equal(snap.state?.display, true);
  assert.equal(snap.offAt, null);
});

test("turns on and changes temperature, mode, fan and swing", async () => {
  const snap = await ac.set({ power: true, target: 21, mode: "heat", fan: "low", swing: "vertical" });
  assert.equal(snap.status, "ready");
  assert.deepEqual(
    { ...fake.state, indoor: undefined, outdoor: undefined },
    { power: true, target: 21, mode: 4, fan: 40, swing: 12, eco: false, turbo: false, sleep: false, indoor: undefined, outdoor: undefined, display: true, selfClean: false, filter: false },
  );
  assert.equal(snap.state?.power, true);
  assert.equal(snap.state?.target, 21);
  assert.equal(snap.state?.mode, "heat");
  assert.equal(snap.state?.fan, "low");
  assert.equal(snap.state?.swing, "vertical");
});

test("a single change leaves the other settings alone", async () => {
  await ac.set({ target: 23 });
  assert.equal(fake.state.target, 23);
  assert.equal(fake.state.mode, 4);
  assert.equal(fake.state.fan, 40);
  assert.equal(fake.state.power, true);
});

test("clamps the target to what the unit accepts", async () => {
  const caps = (await ac.refresh()).caps!;
  assert.equal((await ac.set({ target: 99 })).state?.target, caps.maxTemp);
  assert.equal((await ac.set({ target: -5 })).state?.target, caps.minTemp);
});

test("picks up a change made on the remote before sending its own", async () => {
  fake.state.mode = 2; // someone pressed Cool on the remote
  await new Promise((r) => setTimeout(r, 5200));
  await ac.set({ target: 22 });
  assert.equal(fake.state.mode, 2, "must not send the stale Heat mode back");
  assert.equal(fake.state.target, 22);
});

test("eco and turbo exclude each other", async () => {
  await ac.set({ turbo: true });
  assert.equal(fake.state.turbo, true);
  const snap = await ac.set({ eco: true });
  assert.equal(fake.state.eco, true);
  assert.equal(fake.state.turbo, false);
  assert.equal(snap.state?.eco, true);
});

test("beep follows the setting", async () => {
  store.beep = false;
  await ac.set({ power: true });
  assert.equal(fake.received.at(-1)![1]! & 0x40, 0);
  store.beep = true;
  await ac.set({ power: true });
  assert.equal(fake.received.at(-1)![1]! & 0x40, 0x40);
});

test("sets half degrees", async () => {
  const snap = await ac.set({ target: 23.5 });
  assert.equal(fake.state.target, 23.5);
  assert.equal(snap.state?.target, 23.5);
  assert.equal(snap.caps?.step, 0.5);
  assert.equal((await ac.set({ target: 23.26 })).state?.target, 23.5);
});

test("learns that a unit ignores half degrees and stops offering them", async () => {
  fake.quirks.wholeDegrees = true;
  const first = await ac.set({ target: 22.5 });
  assert.equal(first.state?.target, 22);
  assert.equal(first.caps?.step, 1);
  assert.equal(new Store(store.path).devices[0]?.wholeDegrees, true);
  assert.equal((await ac.set({ target: 24.5 })).state?.target, 25, "rounds to whole degrees from now on");
  fake.quirks.wholeDegrees = false;
  store.learn(fake.id, { wholeDegrees: false });
});

test("switches the display light without resending the other settings", async () => {
  const before = fake.received.length;
  const off = await ac.set({ display: false });
  assert.equal(fake.state.display, false);
  assert.equal(off.state?.display, false);
  await ac.set({ display: false });
  assert.equal(fake.state.display, false, "asking for the state it already has does nothing");
  assert.equal((await ac.set({ display: true })).state?.display, true);
  assert.equal(fake.received.length, before);
});

test("starts a self-clean cycle", async () => {
  const snap = await ac.selfClean();
  assert.equal(fake.state.selfClean, true);
  assert.equal(snap.state?.selfClean, true);
  fake.state.selfClean = false;
});

test("reads energy in the alternate encoding when asked", async () => {
  store.energyBinary = true;
  const snap = await ac.refresh();
  assert.equal(snap.state?.watts, 0x004321 / 10);
  store.energyBinary = false;
});

test("off timer is set, survives a reload, and is cancelled by switching off", async () => {
  const before = Date.now();
  const snap = ac.setOffTimer(90);
  assert.ok(snap.offAt! >= before + 90 * 60_000 && snap.offAt! <= Date.now() + 90 * 60_000);
  assert.equal(new Store(store.path).offAt, snap.offAt);
  assert.equal(ac.setOffTimer(0).offAt, null, "nonsense durations cancel");
  ac.setOffTimer(30);
  assert.equal((await ac.set({ power: false })).offAt, null);
  await ac.set({ power: true });
});

test("stays online when a unit never answers the energy request", async () => {
  fake.quirks.energySilent = true;
  const snap = await ac.refresh();
  assert.equal(snap.status, "ready");
  assert.equal(snap.caps?.energy, false);
  fake.quirks.energySilent = false;
});

test("config is private and survives a reload", () => {
  const again = new Store(store.path);
  assert.equal(again.selected?.id, fake.id);
  assert.equal(again.beep, true);
});

test("recovers when the unit drops an idle connection", async () => {
  const port = fake.port;
  await fake.close(); // kills the socket the controller is holding
  fake = await startFakeAc(port, fake.id);
  const snap = await ac.set({ target: 25 });
  assert.equal(snap.status, "ready");
  assert.equal(fake.state.target, 25);
});

test("reports offline when the unit stops answering, then recovers", async () => {
  const port = fake.port;
  await fake.close();
  const down = await ac.refresh();
  assert.equal(down.status, "offline");
  assert.equal(down.state, null);
  assert.match(down.message ?? "", /No answer from 127\.0\.0\.1/);

  fake = await startFakeAc(port, fake.id);
  const up = await ac.refresh();
  assert.equal(up.status, "ready");
});

test("finds a unit by address, pairs with it and saves it", async () => {
  const unit = await startFakeAc(0, 0x0000_0abc_def0, 6445);
  try {
    const fresh = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
    const snap = await new AcController(fresh).scan("127.0.0.1");
    assert.equal(snap.status, "ready");
    assert.equal(snap.state?.target, 24);
    assert.deepEqual(fresh.devices, [
      { id: unit.id, ip: "127.0.0.1", port: unit.port, name: "net_ac_DEF0", sn: "000000P0000000Q1FAKE000000000000", version: 2 },
    ]);
    assert.equal(fresh.selected?.id, unit.id);
  } finally {
    await unit.close();
  }
});

test("says so when nothing answers at an address", async () => {
  const fresh = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
  const snap = await new AcController(fresh).scan("127.0.0.1");
  assert.equal(snap.status, "no-device");
  assert.match(snap.message ?? "", /Nothing answered at 127\.0\.0\.1/);
});

test("asks for the owner's sign-in when a unit needs a cloud key", async () => {
  const unit = await startFakeAc(0, 0x0000_0abc_def0, 6445, true);
  try {
    const fresh = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
    const snap = await new AcController(fresh).scan("127.0.0.1");
    assert.equal(snap.status, "needs-account");
    assert.equal(snap.message, undefined);
    assert.deepEqual(fresh.devices, []);
  } finally {
    await unit.close();
  }
});

test("finds out by asking that a unit meters itself even when it does not say so", async () => {
  const unit = await startFakeAc(0, 0x0000_0abc_0001);
  unit.quirks.energyUnlisted = true;
  try {
    const fresh = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
    fresh.upsert({ id: unit.id, ip: "127.0.0.1", port: unit.port, name: "net_ac_0001", sn: "T", version: 2 });
    const snap = await new AcController(fresh).refresh();
    assert.equal(snap.caps?.energy, true);
    assert.equal(snap.state?.kwh, 1234.56);
    assert.equal(fresh.devices[0]?.meters, true);
  } finally {
    await unit.close();
  }
});

test("remembers that a unit does not meter itself and never asks again", async () => {
  const unit = await startFakeAc(0, 0x0000_0abc_0002);
  unit.quirks.energyUnlisted = true;
  unit.quirks.energySilent = true;
  try {
    const fresh = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
    fresh.upsert({ id: unit.id, ip: "127.0.0.1", port: unit.port, name: "net_ac_0002", sn: "T", version: 2 });
    const first = await new AcController(fresh).refresh();
    assert.equal(first.status, "ready");
    assert.equal(first.caps?.energy, false);
    assert.equal(fresh.devices[0]?.meters, false);

    const started = Date.now();
    const again = await new AcController(new Store(fresh.path)).refresh();
    assert.equal(again.status, "ready");
    assert.ok(Date.now() - started < 2000, "a second launch must not wait on the energy request again");
  } finally {
    await unit.close();
  }
});

test("popover layout: everything by default, presets and single sections persist, junk is ignored", async () => {
  const { FULL_LAYOUT, MINIMAL_LAYOUT } = await import("../src/core/store");
  const fresh = new Store(join(mkdtempSync(join(tmpdir(), "mideabar-")), "config.json"));
  assert.deepEqual(fresh.layout, FULL_LAYOUT);
  fresh.setLayout(MINIMAL_LAYOUT);
  assert.deepEqual(new Store(fresh.path).layout, MINIMAL_LAYOUT);
  fresh.setLayout({ insight: true, unit: "yes" as unknown as boolean });
  assert.deepEqual(new Store(fresh.path).layout, { ...MINIMAL_LAYOUT, insight: true });
});
