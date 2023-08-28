import { BrowserWindow } from "../ipc";

export function getBrowserWindow(): BrowserWindow|undefined {
  return (window as any).browserWindow as BrowserWindow|undefined;
}
