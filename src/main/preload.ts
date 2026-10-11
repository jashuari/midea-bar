import { contextBridge, ipcRenderer } from "electron";
import type { Electricity, Patch, Snapshot, Trend } from "../core/types";

/** The only surface the popover can reach. No Node, no network. */
const api = {
  get: (): Promise<Snapshot> => ipcRenderer.invoke("ac:get"),
  refresh: (): Promise<Snapshot> => ipcRenderer.invoke("ac:refresh"),
  set: (patch: Patch): Promise<Snapshot> => ipcRenderer.invoke("ac:set", patch),
  scan: (ip?: string): Promise<Snapshot> => ipcRenderer.invoke("ac:scan", ip),
  pair: (account: string, password: string): Promise<Snapshot> => ipcRenderer.invoke("ac:pair", account, password),
  select: (id: number): Promise<Snapshot> => ipcRenderer.invoke("ac:select", id),
  rename: (label: string): Promise<Snapshot> => ipcRenderer.invoke("ac:rename", label),
  timer: (minutes: number | null): Promise<Snapshot> => ipcRenderer.invoke("ac:timer", minutes),
  trend: (): Promise<Trend> => ipcRenderer.invoke("trend:get"),
  costSettings: (changes: Partial<Electricity>): Promise<Snapshot> => ipcRenderer.invoke("cost:settings", changes),
  hide: (): void => ipcRenderer.send("ui:hide"),
  resize: (height: number): void => ipcRenderer.send("ui:resize", height),
  menu: (): void => ipcRenderer.send("ui:menu"),
  onSnapshot: (listener: (snap: Snapshot) => void): void => {
    ipcRenderer.on("ac:snapshot", (_event, snap: Snapshot) => listener(snap));
  },
};

export type Api = typeof api;

contextBridge.exposeInMainWorld("ac", api);
