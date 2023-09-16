const { contextBridge, ipcRenderer } = require('electron');
import { BrowserWindow } from '../ipc';

// contextBridge.exposeInMainWorld('browserWindow', {
//   active: () => ipcRenderer.invoke('browserWindow.active'),
// })

const browserWindow: BrowserWindow = {
  active: () => ipcRenderer.invoke('browserWindow.active') as Promise<boolean>,
  showFileInBrowser: (absPath: string) => ipcRenderer.invoke('browserWindow.showFileInBrowser', absPath),
  showDirectoryPicker: () => ipcRenderer.invoke('browserWindow.showDirectoryPicker') as Promise<string|undefined>,

  getCustomStyles: () => ipcRenderer.invoke('browserWindow.getCustomStyles') as Promise<[string|undefined, string|undefined]>,
  setCustomStyles: (styles: [string|undefined, string|undefined]) => ipcRenderer.invoke('browserWindow.setCustomStyles', styles),
};
(window as any).browserWindow = browserWindow;

ipcRenderer.on('browserWindow.onDidActiveChange', (event, newState: boolean) => { browserWindow.onDidActiveChange?.(newState); } );
