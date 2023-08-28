import { getBrowserWindow } from "./renderer-ipc";

export function isElectron() {
  return getBrowserWindow() !== undefined;
}
