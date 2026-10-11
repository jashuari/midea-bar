import { app, BrowserWindow, ipcMain, Menu, nativeImage, Notification, powerMonitor, screen, Tray } from "electron";
import type { NativeImage } from "electron";
import { join } from "node:path";
import { checkAlerts } from "../core/alerts";
import { AcController } from "../core/controller";
import { HistoryLog } from "../core/history";
import { Store } from "../core/store";
import type { Alert, Electricity, Patch, Snapshot } from "../core/types";
import { UsageLog } from "../core/usage";

const WIDTH = 320;
/** Starting height; the popover reports its real content height once it has drawn. */
const HEIGHT = 430;
/** Poll slowly in the background, quickly while the popover is open. */
const POLL_HIDDEN_MS = 60_000;
const POLL_VISIBLE_MS = 10_000;

// Must match the folder the CLI reads, see core/store.ts.
app.setName("MideaBar");

let tray: Tray | null = null;
let win: BrowserWindow | null = null;
let controller: AcController;
let usage: UsageLog;
let history: HistoryLog;
/** What currently needs attention, as of the last real reading. */
let alerts: Alert[] = [];

/** Room temperature over the last day, thinned to a few dozen values for the small chart. */
function spark(): Snapshot["spark"] {
  const rooms = history.trend().points.map((p) => p.indoor).filter((v): v is number => v !== null);
  if (rooms.length < 2) return undefined;
  const every = Math.max(1, Math.ceil(rooms.length / 48));
  const values = rooms.filter((_, i) => i % every === 0 || i === rooms.length - 1);
  return { values, min: Math.min(...rooms), max: Math.max(...rooms) };
}

/** Add everything the popover shows beyond the unit's own state. */
function decorate(bare: Snapshot): Snapshot {
  return {
    ...bare,
    cost: usage.summary(controller.store.electricity),
    spark: spark(),
    alerts: bare.status === "ready" ? alerts : [],
  };
}

function announce(alert: Alert): void {
  if (!controller.store.notify || !Notification.isSupported()) return;
  const note = new Notification({ title: alert.title, body: alert.body, silent: alert.severity !== "problem" });
  note.on("click", () => {
    if (!win?.isVisible()) togglePopover();
  });
  note.show();
}
let pollTimer: NodeJS.Timeout | null = null;
let offTimer: NodeJS.Timeout | null = null;
let iconOn: NativeImage;
let iconOff: NativeImage;

/**
 * The off timer runs in this app, not in the unit, so it needs the Mac awake.
 * If the Mac slept through the deadline by more than this, the timer is dropped
 * rather than switching the unit off at some surprising later moment.
 */
const TIMER_GRACE_MS = 10 * 60_000;

function armOffTimer(): void {
  if (offTimer) clearTimeout(offTimer);
  offTimer = null;
  const at = controller.store.offAt;
  if (at === null) return;
  offTimer = setTimeout(async () => {
    controller.store.setOffTimer(null);
    if (Date.now() - at > TIMER_GRACE_MS) return void publish(controller.snapshot());
    publish(await controller.set({ power: false }));
  }, Math.max(0, at - Date.now()));
}

const asset = (name: string) => join(__dirname, "..", "assets", name);

/** Send the latest state to the popover and mirror it in the menu bar. */
function publish(bare: Snapshot): Snapshot {
  // Every real reading of the unit feeds the usage log; every snapshot carries the bill so far.
  if (bare.status === "ready" && bare.state) {
    usage.record(bare.state);
    history.record(bare.state);
    const marks = controller.store.alerted;
    const result = checkAlerts(bare.device?.label ?? "The air conditioner", bare.state, history, marks);
    alerts = result.active;
    if (result.notify.length > 0) {
      controller.store.saveAlerted();
      result.notify.forEach(announce);
    }
  }
  usage.save();
  history.save();
  const snap = decorate(bare);
  win?.webContents.send("ac:snapshot", snap);
  armOffTimer();
  if (!tray) return snap;

  const s = snap.state;
  // Air coming out of the unit means it is running.
  tray.setImage(s?.power ? iconOn : iconOff);
  // The menu bar shows the target while the unit runs, and nothing when it is off.
  tray.setTitle(s?.power ? ` ${s.target}°` : "");
  tray.setToolTip(
    snap.status === "ready" && s
      ? `${snap.device?.label}: ${s.power ? `${s.mode}, set to ${s.target}°` : "off"}` +
          (s.indoor !== null ? `. Room ${s.indoor}°` : "")
      : snap.status === "needs-account"
        ? "MideaBar: sign in to SmartHome once to finish pairing"
        : snap.status === "no-device"
          ? "MideaBar: no air conditioner set up"
          : `${snap.device?.label ?? "MideaBar"}: unreachable`,
  );
  return snap;
}

function schedulePoll(): void {
  if (pollTimer) clearTimeout(pollTimer);
  const delay = win?.isVisible() ? POLL_VISIBLE_MS : POLL_HIDDEN_MS;
  pollTimer = setTimeout(async () => {
    // Nothing to read until a unit is paired.
    if (controller.store.selected) publish(await controller.refresh());
    schedulePoll();
  }, delay);
}

function createWindow(): BrowserWindow {
  const w = new BrowserWindow({
    width: WIDTH,
    height: HEIGHT,
    show: false,
    frame: false,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    transparent: true,
    hasShadow: true,
    vibrancy: "popover",
    visualEffectState: "active",
    webPreferences: {
      preload: join(__dirname, "preload.cjs"),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });
  w.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  void w.loadFile(join(__dirname, "renderer", "index.html"));
  w.on("blur", () => w.hide());
  w.on("hide", schedulePoll);
  // The popover is the whole app; never let it navigate or open anything.
  w.webContents.on("will-navigate", (e) => e.preventDefault());
  w.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
  return w;
}

function togglePopover(): void {
  if (!win || !tray) return;
  if (win.isVisible()) return win.hide();

  const icon = tray.getBounds();
  const area = screen.getDisplayNearestPoint({ x: icon.x, y: icon.y }).workArea;
  const x = Math.round(icon.x + icon.width / 2 - WIDTH / 2);
  win.setPosition(
    Math.min(Math.max(x, area.x + 8), area.x + area.width - WIDTH - 8),
    Math.max(icon.y + icon.height + 4, area.y + 4),
    false,
  );
  win.show();
  win.focus();
  schedulePoll();
  void controller.refresh(true).then(publish);
}

function showMenu(): void {
  const snap = controller.snapshot();
  const store = controller.store;
  const login = app.getLoginItemSettings().openAtLogin;

  const menu = Menu.buildFromTemplate([
    ...snap.devices.map((d) => ({
      label: d.label,
      type: "radio" as const,
      checked: d.id === snap.device?.id,
      click: () => void controller.select(d.id).then(publish),
    })),
    ...(snap.devices.length > 0 ? [{ type: "separator" as const }] : []),
    {
      label: "Look for air conditioners",
      click: () => {
        publish({ ...controller.snapshot(), status: "scanning" });
        void controller.scan().then(publish);
      },
    },
    ...(snap.caps?.selfClean
      ? [
          {
            label: snap.state?.selfClean ? "Self-clean is running" : "Start self-clean",
            enabled: !snap.state?.selfClean,
            click: () => void controller.selfClean().then(publish),
          },
        ]
      : []),
    ...(snap.caps?.energy
      ? [
          {
            // Units report energy in one of two encodings without saying which.
            label: "Energy figures look wrong: use the other format",
            type: "checkbox" as const,
            checked: store.energyBinary,
            click: (item: Electron.MenuItem) => {
              store.energyBinary = item.checked;
              publish(controller.snapshot());
            },
          },
        ]
      : []),
    {
      label: "Notify me about problems",
      type: "checkbox",
      checked: store.notify,
      click: (item) => {
        store.notify = item.checked;
      },
    },
    {
      label: "Send a test notification",
      enabled: store.notify,
      click: () =>
        announce({
          key: "filter",
          severity: "note",
          title: "MideaBar notifications work",
          body: "This is what a nudge about your air conditioner will look like.",
        }),
    },
    {
      label: "Beep when a setting changes",
      type: "checkbox",
      checked: store.beep,
      click: (item) => {
        store.beep = item.checked;
      },
    },
    {
      label: "Open at login",
      type: "checkbox",
      checked: login,
      click: (item) => app.setLoginItemSettings({ openAtLogin: item.checked }),
    },
    { type: "separator" },
    { label: `MideaBar ${app.getVersion()}`, enabled: false },
    { label: "Quit MideaBar", accelerator: "Command+Q", click: () => app.quit() },
  ]);
  tray?.popUpContextMenu(menu);
}

function wireIpc(): void {
  ipcMain.handle("ac:get", () => decorate(controller.snapshot()));
  ipcMain.handle("trend:get", () => history.trend());
  ipcMain.handle("cost:settings", (_e, changes: Partial<Electricity>) => {
    if (changes && typeof changes === "object") controller.store.setElectricity(changes);
    return publish(controller.snapshot());
  });
  ipcMain.handle("ac:refresh", async () => publish(await controller.refresh(true)));
  ipcMain.handle("ac:set", async (_e, patch: Patch) => publish(await controller.set(patch)));
  ipcMain.handle("ac:scan", async (_e, ip?: string) => {
    publish({ ...controller.snapshot(), status: "scanning" });
    return publish(await controller.scan(typeof ip === "string" && ip.trim() ? ip.trim() : undefined));
  });
  ipcMain.handle("ac:pair", async (_e, account: unknown, password: unknown) => {
    if (typeof account !== "string" || typeof password !== "string" || !account.trim() || !password) {
      return controller.snapshot();
    }
    publish({ ...controller.snapshot(), status: "scanning" });
    // The password lives only in this call: it goes to Midea's sign-in and is never written anywhere.
    return publish(await controller.pair({ account: account.trim(), password }));
  });
  ipcMain.handle("ac:select", async (_e, id: number) => publish(await controller.select(id)));
  ipcMain.handle("ac:rename", (_e, label: string) => {
    const current = controller.store.selected;
    if (current) controller.store.rename(current.id, String(label).slice(0, 40));
    return publish(controller.snapshot());
  });
  ipcMain.handle("ac:timer", (_e, minutes: unknown) =>
    publish(controller.setOffTimer(typeof minutes === "number" ? minutes : null)),
  );
  ipcMain.on("ui:hide", () => win?.hide());
  ipcMain.on("ui:resize", (_e, height: number) => {
    if (!win || !Number.isFinite(height)) return;
    const h = Math.min(Math.max(Math.round(height), 160), 760);
    if (win.getSize()[1] !== h) win.setSize(WIDTH, h, false);
  });
  ipcMain.on("ui:menu", showMenu);
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", togglePopover);
  // Closing the popover must not quit a menu bar app.
  app.on("window-all-closed", () => {});

  void app.whenReady().then(() => {
    app.dock?.hide();

    controller = new AcController(new Store(join(app.getPath("userData"), "config.json")));
    usage = new UsageLog(join(app.getPath("userData"), "usage.json"));
    history = new HistoryLog(join(app.getPath("userData"), "history.json"));
    app.on("before-quit", () => {
      usage.save(true);
      history.save(true);
    });
    wireIpc();

    iconOn = nativeImage.createFromPath(asset("trayOnTemplate.png"));
    iconOff = nativeImage.createFromPath(asset("trayOffTemplate.png"));
    iconOn.setTemplateImage(true);
    iconOff.setTemplateImage(true);
    tray = new Tray(iconOff);
    tray.on("click", togglePopover);
    tray.on("right-click", showMenu);

    win = createWindow();

    // First launch: open the popover and find the unit without being asked.
    // Later launches: stay in the menu bar and just read the unit.
    if (!controller.store.selected) {
      void controller.scan().then(publish);
      win.webContents.once("did-finish-load", () => setTimeout(togglePopover, 400));
    } else {
      void controller.refresh(true).then(publish);
    }
    schedulePoll();
    armOffTimer();
    // Timers do not run while the Mac sleeps; catch up the moment it wakes.
    powerMonitor.on("resume", () => {
      armOffTimer();
      if (controller.store.selected) void controller.refresh(true).then(publish);
    });
  });
}
