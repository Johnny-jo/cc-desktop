import { contextBridge, ipcRenderer } from "electron";
import { IPC } from "@claude-desktop/shared";

const desktop = {
  openProject: (path: string) => ipcRenderer.invoke(IPC.projectOpen, { path }),
  on: (channel: string, listener: (...args: unknown[]) => void) => {
    const allowed = new Set(Object.values(IPC));
    if (!allowed.has(channel as never)) return () => {};
    const handler = (_: unknown, payload: unknown) => listener(payload);
    ipcRenderer.on(channel, handler);
    return () => ipcRenderer.removeListener(channel, handler);
  },
};

contextBridge.exposeInMainWorld("desktop", desktop);

export type DesktopApi = typeof desktop;
