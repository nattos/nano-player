const { contextBridge, ipcRenderer } = require('electron');
import { BrowserWindow } from '../ipc';

// contextBridge.exposeInMainWorld('browserWindow', {
//   active: () => ipcRenderer.invoke('browserWindow.active'),
// })

const browserWindow: BrowserWindow = {
  active: () => ipcRenderer.invoke('browserWindow.active') as Promise<boolean>,
};
(window as any).browserWindow = browserWindow;

ipcRenderer.on('browserWindow.onDidActiveChange', (event, newState: boolean) => { browserWindow.onDidActiveChange?.(newState); } );
